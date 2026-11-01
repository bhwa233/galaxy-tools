using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Spark.Traffic {
  public sealed class DirectoryGuard:IDisposable {
    static readonly SecurityIdentifier system=new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),admins=new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null),users=new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid,null),authenticated=new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid,null);
    readonly List<SafeFileHandle> pins=new List<SafeFileHandle>();
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int kind,IntPtr data,int length);
    public static FileStream OpenInput(string path) {
      var handle=CreateFile(path,0x80000000,1,IntPtr.Zero,3,0x00200000|0x08000000,IntPtr.Zero);
      if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
      var info=Marshal.AllocHGlobal(8);
      try{if(!GetFileInformationByHandleEx(handle,9,info,8)||(Marshal.ReadInt32(info)&((int)FileAttributes.ReparsePoint|(int)FileAttributes.Directory))!=0)throw new IOException("unsafe-input-file");return new FileStream(handle,FileAccess.Read);}
      catch{handle.Dispose();throw;}finally{Marshal.FreeHGlobal(info);}
    }
    public static FileStream CreatePrivateFile(string path) {
      // An elevated user's SID remains the owner under default creation. Set Administrators as owner atomically so the ordinary token cannot later rewrite a service DLL's DACL.
      var security=new FileSecurity();security.SetOwner(admins);security.SetAccessRuleProtection(false,false);
      foreach(var sid in new[]{system,admins})security.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,AccessControlType.Allow));
      return new FileStream(path,FileMode.CreateNew,FileSystemRights.WriteData,FileShare.None,4096,FileOptions.WriteThrough,security);
    }
    public static void WritePrivateFile(string path,byte[] bytes) {
      var temporary=path+"."+Guid.NewGuid().ToString("N")+".new";
      using(var stream=CreatePrivateFile(temporary)){stream.Write(bytes,0,bytes.Length);stream.Flush(true);}
      if(File.Exists(path))File.Replace(temporary,path,null);else File.Move(temporary,path);
    }
    public static DirectorySecurity Policy(bool code) {
      var security=new DirectorySecurity();security.SetOwner(admins);security.SetAccessRuleProtection(true,false);
      foreach(var sid in new[]{system,admins})security.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
      if(code)security.AddAccessRule(new FileSystemAccessRule(users,FileSystemRights.ReadAndExecute,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
      return security;
    }
    public static void CreateProtected(string path,bool code) {
      if(Directory.Exists(path)){Check(path,code);return;}
      var parent=Path.GetDirectoryName(Path.GetFullPath(path));
      if(!Directory.Exists(parent))throw new IOException("protected-parent-missing");
      Directory.CreateDirectory(path,Policy(code));Check(path,code);
    }
    public static void Check(string path,bool code) {
      if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)throw new IOException("reparse-path-rejected");
      var security=Directory.GetAccessControl(path,AccessControlSections.Owner|AccessControlSections.Access);
      ValidateSecurity(security,code);
    }
    public static void ValidateSecurity(DirectorySecurity security,bool code) {
      var owner=(SecurityIdentifier)security.GetOwner(typeof(SecurityIdentifier));
      if(!owner.Equals(system)&&!owner.Equals(admins))throw new UnauthorizedAccessException("untrusted-directory-owner");
      if(!security.AreAccessRulesProtected)throw new UnauthorizedAccessException("directory-acl-not-protected");
      var full=new HashSet<string>();
      foreach(FileSystemAccessRule rule in security.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
        var sid=(SecurityIdentifier)rule.IdentityReference;
        if(rule.AccessControlType!=AccessControlType.Allow)continue;
        if(sid.Equals(system)||sid.Equals(admins)){if((rule.FileSystemRights&FileSystemRights.FullControl)==FileSystemRights.FullControl)full.Add(sid.Value);continue;}
        var allowed=FileSystemRights.ReadAndExecute|FileSystemRights.Synchronize;
        if(!code||(!sid.Equals(users)&&!sid.Equals(authenticated))||(rule.FileSystemRights&~allowed)!=0)throw new UnauthorizedAccessException("unsafe-directory-acl");
      }
      if(!full.Contains(system.Value)||!full.Contains(admins.Value))throw new UnauthorizedAccessException("required-directory-acl-missing");
    }
    public static DirectoryGuard OpenProtected(string path,bool code) {
      var guard=Pin(path);
      try{Check(path,code);return guard;}catch{guard.Dispose();throw;}
    }
    public static DirectoryGuard Pin(string path) {
      var guard=new DirectoryGuard();
      try {
        var parts=new List<string>();var current=Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar);
        for(;;){parts.Add(current);var parent=Path.GetDirectoryName(current);if(string.IsNullOrEmpty(parent)||parent==current)break;current=parent;}
        parts.Reverse();
        foreach(var part in parts) {
          var handle=CreateFile(part,0x80,3,IntPtr.Zero,3,0x02000000|0x00200000,IntPtr.Zero);
          if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
          guard.pins.Add(handle);
          if((File.GetAttributes(part)&FileAttributes.ReparsePoint)!=0)throw new IOException("reparse-path-rejected");
        }
        return guard;
      }catch{guard.Dispose();throw;}
    }
    public void Dispose(){foreach(var handle in pins)handle.Dispose();pins.Clear();}
  }
}
