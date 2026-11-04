using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace Spark.Traffic {
  // Existing ProcessCatalog supplies identity checks; Windows Shell owns file
  // dialogs. There is no managed equivalent for selecting a file/properties or
  // terminating the exact handle whose creation time was checked, so P/Invoke
  // stays confined to these operations. Only the user-mode client calls Run.
  public static class ProcessActions {
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessCritical(IntPtr process,out bool critical);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int kind,IntPtr data,int size,out int returned);
    [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern int SHParseDisplayName(string path,IntPtr context,out IntPtr pidl,uint attributes,out uint actual);
    [DllImport("shell32.dll")] static extern int SHOpenFolderAndSelectItems(IntPtr pidl,uint count,IntPtr items,uint flags);
    [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ShellExecuteEx(ref ShellInfo info);
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct ShellInfo {
      public int size;public uint mask;public IntPtr hwnd;
      [MarshalAs(UnmanagedType.LPWStr)] public string verb;
      [MarshalAs(UnmanagedType.LPWStr)] public string file;
      [MarshalAs(UnmanagedType.LPWStr)] public string parameters;
      [MarshalAs(UnmanagedType.LPWStr)] public string directory;
      public int show;public IntPtr instance,pidl;
      [MarshalAs(UnmanagedType.LPWStr)] public string className;
      public IntPtr classKey;public uint hotKey;public IntPtr icon,process;
    }
    static int Parent(int pid) {
      var handle=Native.OpenProcess(0x1000,false,pid);if(handle==IntPtr.Zero)return 0;
      var data=Marshal.AllocHGlobal(IntPtr.Size*6);
      try {return NtQueryInformationProcess(handle,0,data,IntPtr.Size*6,out _)==0?checked((int)Marshal.ReadIntPtr(data,IntPtr.Size*5).ToInt64()):0;}
      finally {Marshal.FreeHGlobal(data);Native.CloseHandle(handle);}
    }
    public static int DesktopHost() {
      var pid=Parent(Process.GetCurrentProcess().Id);var owner=ProcessCatalog.Inspect(pid);
      var name=owner?.Path==null?"":Path.GetFileName(owner.Path);
      if(!name.Equals("electron.exe",StringComparison.OrdinalIgnoreCase)&&!name.Equals("spark233.exe",StringComparison.OrdinalIgnoreCase))return 0;
      for(var i=0;i<16;i++) {
        var parent=Parent(pid);var next=ProcessCatalog.Inspect(parent);
        if(parent<=0||parent==pid||next==null||!string.Equals(next.Path,owner.Path,StringComparison.OrdinalIgnoreCase))break;
        pid=parent;owner=next;
      }
      return pid;
    }
    static bool BelongsToHost(int pid,int host) {
      if(host<=0)return false;
      for(var i=0;i<64&&pid>0;i++) {if(pid==host)return true;var next=Parent(pid);if(next==pid)break;pid=next;}
      return false;
    }
    public static object Run(ProcessIdentity target,string action,int hostPid=0) {
      if(action!="reveal"&&action!="properties"&&action!="terminate")throw new InvalidDataException("unsupported-process-action");
      if(target==null||target.Pid<=4||target.Created<=0||string.IsNullOrEmpty(target.Sid))throw new InvalidOperationException("process-identity-unavailable");
      var handle=Native.OpenProcess(action=="terminate"?0x1001u:0x1000u,false,target.Pid);
      if(handle==IntPtr.Zero)throw new InvalidOperationException(Marshal.GetLastWin32Error()==87?"process-exited":"process-access-denied");
      try {
        // Check and act on the same handle: PID reuse cannot retarget termination.
        var live=Native.ReadProcessHandle(handle,target.Pid,target.Boot);
        if(live==null||live.Created!=target.Created||live.Sid!=target.Sid||!string.Equals(live.Path,target.Path,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("process-identity-changed");
        if(action=="terminate") {
          var name=Path.GetFileName(live.Path??"");
          if(target.Pid==Process.GetCurrentProcess().Id||BelongsToHost(Process.GetCurrentProcess().Id,target.Pid)||BelongsToHost(target.Pid,hostPid)||name.StartsWith("spark233.Traffic",StringComparison.OrdinalIgnoreCase)||!IsProcessCritical(handle,out var critical)||critical)throw new InvalidOperationException("process-protected");
          if(!TerminateProcess(handle,1))throw new InvalidOperationException("process-access-denied");
          return Json.Obj("status","terminated","pid",target.Pid);
        }
        if(string.IsNullOrEmpty(live.Path)||!File.Exists(live.Path))throw new InvalidOperationException("process-file-unavailable");
        Exception failure=null;var finished=new ManualResetEventSlim();
        var thread=new Thread(()=>{
          try {
            if(action=="reveal") {
              Marshal.ThrowExceptionForHR(SHParseDisplayName(live.Path,IntPtr.Zero,out var item,0,out _));
              try {Marshal.ThrowExceptionForHR(SHOpenFolderAndSelectItems(item,0,IntPtr.Zero,0));}finally{Marshal.FreeCoTaskMem(item);}
            } else {
              var info=new ShellInfo {size=Marshal.SizeOf(typeof(ShellInfo)),mask=0x0000000C|0x00000400,verb="properties",file=live.Path,show=1};
              if(!ShellExecuteEx(ref info))throw new InvalidOperationException("process-shell-failed");
            }
          }catch(Exception ex){failure=ex;}finally{finished.Set();}
        }){IsBackground=true};thread.SetApartmentState(ApartmentState.STA);thread.Start();
        if(!finished.Wait(10000))throw new InvalidOperationException("process-shell-timeout");
        if(failure!=null)throw new InvalidOperationException("process-shell-failed",failure);
        return Json.Obj("status","opened","pid",target.Pid);
      }finally{Native.CloseHandle(handle);}
    }
  }
}
