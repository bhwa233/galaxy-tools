using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;
using Spark.Traffic;

namespace Spark.TrafficClient {
  static class ServerIdentity {
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe,out uint pid);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenSCManager(string machine,string database,uint access);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenService(IntPtr manager,string name,uint access);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool QueryServiceStatusEx(IntPtr service,int level,IntPtr buffer,int size,out int needed);
    [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr handle);
    public static void Verify(NamedPipeClientStream pipe,bool isolated) {
      if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle,out var pid))throw new Win32Exception(Marshal.GetLastWin32Error());
      if(isolated) {
        var server=ProcessCatalog.Inspect(checked((int)pid));if(server==null||server.Path==null)throw new IOException("pipe-server-identity-unavailable");
        using(var identity=System.Security.Principal.WindowsIdentity.GetCurrent())if(server.Sid!=identity.User.Value||!string.Equals(server.Path,Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"spark233.TrafficService.exe"),StringComparison.OrdinalIgnoreCase))throw new IOException("isolated-pipe-server-mismatch");
        return;
      }
      var manager=OpenSCManager(null,null,1);if(manager==IntPtr.Zero)throw new IOException("service-manager-unavailable");
      try {
        var service=OpenService(manager,"spark233Traffic",4);if(service==IntPtr.Zero)throw new IOException("service-not-installed");
        try {
          var buffer=Marshal.AllocHGlobal(36);
          // A normal user need not open a SYSTEM process. SCM provides the protected running service's PID and executable configuration.
          try{if(!QueryServiceStatusEx(service,0,buffer,36,out _)||Marshal.ReadInt32(buffer,0)!=0x10||Marshal.ReadInt32(buffer,4)!=4||unchecked((uint)Marshal.ReadInt32(buffer,28))!=pid)throw new IOException("pipe-server-is-not-service");}
          finally{Marshal.FreeHGlobal(buffer);}
        }finally{CloseServiceHandle(service);}
      }finally{CloseServiceHandle(manager);}
      string executable;
      using(var key=Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\spark233Traffic",false)) {
        if(key==null)throw new IOException("service-configuration-unavailable");
        var security=key.GetAccessControl(AccessControlSections.Owner|AccessControlSections.Access);
        var owner=(SecurityIdentifier)security.GetOwner(typeof(SecurityIdentifier));
        var system=new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null);var admins=new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null);
        if(!owner.Equals(system)&&!owner.Equals(admins))throw new IOException("untrusted-service-registry-owner");
        var writeRights=RegistryRights.SetValue|RegistryRights.CreateSubKey|RegistryRights.Delete|RegistryRights.ChangePermissions|RegistryRights.TakeOwnership;
        foreach(RegistryAccessRule rule in security.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
          if(rule.AccessControlType!=AccessControlType.Allow||(rule.PropagationFlags&PropagationFlags.InheritOnly)!=0||(rule.RegistryRights&writeRights)==0)continue;
          var sid=(SecurityIdentifier)rule.IdentityReference;
          // Windows management/security services can have inherited registry rights. Specific service SIDs require machine service registration and cannot belong to an ordinary interactive token.
          var serviceSid=sid.Value.StartsWith("S-1-5-80-",StringComparison.Ordinal)&&sid.Value.Split('-').Length==9;
          if(!sid.Equals(system)&&!sid.Equals(admins)&&!serviceSid)throw new IOException("unsafe-service-registry-acl");
        }
        var account=key.GetValue("ObjectName",null,RegistryValueOptions.DoNotExpandEnvironmentNames) as string;var image=key.GetValue("ImagePath",null,RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
        if(!string.Equals(account,"LocalSystem",StringComparison.OrdinalIgnoreCase)||image==null)throw new IOException("service-configuration-mismatch");
        image=image.Trim();
        if(image.Length<3||image[0]!='"'||image[image.Length-1]!='"'||image.Substring(1,image.Length-2).IndexOf('"')>=0)throw new IOException("service-command-line-mismatch");
        executable=image.Substring(1,image.Length-2);
        if(!Path.IsPathRooted(executable)||!string.Equals(Path.GetFullPath(executable),executable,StringComparison.OrdinalIgnoreCase))throw new IOException("untrusted-service-location");
      }
      var expectedRoot=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"spark233","traffic","service")+Path.DirectorySeparatorChar;
      if(!executable.StartsWith(expectedRoot,StringComparison.OrdinalIgnoreCase)||Path.GetFileName(executable)!="spark233.TrafficService.exe")throw new IOException("untrusted-service-location");
      using(var guard=DirectoryGuard.OpenProtected(Path.GetDirectoryName(executable),true)) {
        var serviceRoot=expectedRoot.TrimEnd(Path.DirectorySeparatorChar);var trafficRoot=Path.GetDirectoryName(serviceRoot);
        DirectoryGuard.Check(serviceRoot,true);DirectoryGuard.Check(trafficRoot,true);DirectoryGuard.Check(Path.GetDirectoryName(trafficRoot),true);
        if((File.GetAttributes(executable)&FileAttributes.ReparsePoint)!=0)throw new IOException("reparse-service-executable");
      }
    }
  }
}
