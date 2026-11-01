using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using Microsoft.Win32;
using Spark.Traffic;

namespace Spark.TrafficSetup {
  static class Program {
    const string ServiceName="spark233Traffic";
    static int Main(string[] args) {
      var step=InstallStep.Bootstrap;
      try {
        using(var identity=WindowsIdentity.GetCurrent())if(!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))throw new UnauthorizedAccessException("administrator-required");
        step=InstallStep.Caller;
        if(args.Length!=5||(args[0]!="--install"&&args[0]!="--grant-machine")||args[1]!="--caller-pid"||args[3]!="--caller-created"||!int.TryParse(args[2],out var pid)||!long.TryParse(args[4],out var created))throw new ArgumentException("invalid-installer-arguments");
        var caller=ProcessCatalog.Inspect(pid);var source=Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar);
        if(caller==null||caller.Created!=created||caller.Sid==null||!string.Equals(caller.Path,Path.Combine(source,"spark233.TrafficClient.exe"),StringComparison.OrdinalIgnoreCase))throw new UnauthorizedAccessException("installer-caller-mismatch");
        step=InstallStep.Source;
        using(var sourcePin=DirectoryGuard.Pin(source)) {
          step=InstallStep.SharedRoot;
          var root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"spark233");DirectoryGuard.CreateProtected(root,true);
          step=InstallStep.PrivateDirectories;
          var traffic=Path.Combine(root,"traffic");DirectoryGuard.CreateProtected(traffic,true);
          var data=Path.Combine(traffic,"data");DirectoryGuard.CreateProtected(data,false);
          var versions=Path.Combine(traffic,"service");DirectoryGuard.CreateProtected(versions,true);
          using(var rootPin=DirectoryGuard.OpenProtected(traffic,true))using(var dataPin=DirectoryGuard.OpenProtected(data,false)) {
            step=InstallStep.Package;
            var executable=args[0]=="--install"?Stage(source,versions):null;
            // Package verification and private staging complete before stopping a working old version.
            var grantPath=Path.Combine(data,"grants.json");var oldGrants=File.Exists(grantPath)?File.ReadAllBytes(grantPath):null;
            var grants=oldGrants==null?Json.Obj():Json.Decode(Encoding.UTF8.GetString(oldGrants).TrimStart('\uFEFF'));
            grants[caller.Sid]=args[0]=="--grant-machine"||(grants.TryGetValue(caller.Sid,out var previous)&&previous is bool machine&&machine);
            string oldImage;
            using(var key=Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\"+ServiceName,false))oldImage=key?.GetValue("ImagePath") as string;
            if(executable==null&&oldImage==null)throw new InvalidOperationException("service-not-installed");
            var wasRunning=false;
            if(oldImage!=null)using(var service=new ServiceController(ServiceName))wasRunning=service.Status==ServiceControllerStatus.Running;
            try {
              step=InstallStep.ServiceConfiguration;
              if(oldImage!=null)StopService();
              if(executable!=null) {
                Sc((oldImage==null?"create ":"config ")+ServiceName+" binPath= "+Quote("\""+executable+"\"")+" start= auto obj= LocalSystem DisplayName= \"spark233 Traffic Service\"");
                Sc("description "+ServiceName+" \"Local authenticated traffic capture and history for spark233\"");
                Sc("failure "+ServiceName+" reset= 86400 actions= restart/5000/restart/15000/\"\"/0");
              }
              step=InstallStep.Grants;DirectoryGuard.WritePrivateFile(grantPath,new UTF8Encoding(false).GetBytes(Json.Encode(grants)));
              step=InstallStep.ServiceStart;StartService();
            }catch {
              try {
                if(oldImage!=null){StopService();Sc("config "+ServiceName+" binPath= "+Quote(oldImage));}
                if(oldGrants==null){if(File.Exists(grantPath))File.Delete(grantPath);}else DirectoryGuard.WritePrivateFile(grantPath,oldGrants);
                if(oldImage!=null&&wasRunning)StartService();
              }catch(Exception rollback){Console.Error.WriteLine("traffic-rollback:"+rollback.GetType().Name);}
              throw;
            }
          }
        }
        Console.WriteLine("traffic-install-complete");return 0;
      }catch(Exception ex){Console.Error.WriteLine("traffic-installer:"+step+":"+ex.GetType().Name+":"+ex.Message);return InstallerDiagnostics.ExitCode(ex,step);}
    }
    static string Stage(string source,string versions) {
      using(var manifestFile=DirectoryGuard.OpenInput(Path.Combine(source,"resources.json"))) {
        string manifestText;using(var reader=new StreamReader(manifestFile,new UTF8Encoding(false,true),true,4096,true))manifestText=reader.ReadToEnd();
        if(manifestText.Length>1048576)throw new IOException("resource-manifest-too-large");
        var manifest=Json.Decode(manifestText);var inventory=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        foreach(Dictionary<string,object> record in (IEnumerable)manifest["files"]) {
          var name=Json.Str(record,"name");var extension=Path.GetExtension(name);
          if(string.IsNullOrEmpty(name)||name!=Path.GetFileName(name)||name.Contains(':')||name.Contains('/')||name.Contains('\\')||!new[]{".exe",".dll",".config"}.Contains(extension,StringComparer.OrdinalIgnoreCase)||inventory.ContainsKey(name)||inventory.Count>=256)throw new IOException("invalid-resource-name");
          inventory.Add(name,Json.Str(record,"sha256"));
        }
        if(!inventory.ContainsKey("spark233.TrafficService.exe")||!inventory.ContainsKey("spark233.Traffic.Core.dll")||!inventory.ContainsKey("e_sqlite3.dll"))throw new IOException("incomplete-resource-closure");
        manifestFile.Position=0;var destination=Path.Combine(versions,"v1-"+Hash(manifestFile).Substring(0,20));
        if(Directory.Exists(destination)) {
          using(var guard=DirectoryGuard.OpenProtected(destination,true))foreach(var entry in inventory)using(var input=DirectoryGuard.OpenInput(Path.Combine(destination,entry.Key)))if(!string.Equals(Hash(input),entry.Value,StringComparison.OrdinalIgnoreCase))throw new IOException("installed-resource-hash-mismatch");
          return Path.Combine(destination,"spark233.TrafficService.exe");
        }
        var staging=Path.Combine(versions,"staging-"+Guid.NewGuid().ToString("N"));DirectoryGuard.CreateProtected(staging,false);
        using(var stagingPin=DirectoryGuard.OpenProtected(staging,false)) {
          foreach(var entry in inventory) {
            // Hash and copy the same no-reparse input handle while denying writes and renames.
            using(var input=DirectoryGuard.OpenInput(Path.Combine(source,entry.Key))) {
              if(!string.Equals(Hash(input),entry.Value,StringComparison.OrdinalIgnoreCase))throw new IOException("resource-hash-mismatch");
              input.Position=0;using(var output=DirectoryGuard.CreatePrivateFile(Path.Combine(staging,entry.Key))){input.CopyTo(output);output.Flush(true);}
            }
          }
          DirectoryGuard.WritePrivateFile(Path.Combine(staging,"resources.json"),new UTF8Encoding(false).GetBytes(manifestText));
          var notices=Path.Combine(source,"licenses");
          if(Directory.Exists(notices))using(var noticePin=DirectoryGuard.Pin(notices)) {
            var target=Path.Combine(staging,"licenses");DirectoryGuard.CreateProtected(target,true);
            foreach(var file in Directory.GetFiles(notices).Take(256))using(var input=DirectoryGuard.OpenInput(file))using(var output=DirectoryGuard.CreatePrivateFile(Path.Combine(target,Path.GetFileName(file))))input.CopyTo(output);
          }
        }
        Directory.SetAccessControl(staging,DirectoryGuard.Policy(true));Directory.Move(staging,destination);
        return Path.Combine(destination,"spark233.TrafficService.exe");
      }
    }
    static string Hash(Stream stream){using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
    static string Quote(string text)=>"\""+text.Replace("\"","\\\"")+"\"";
    static void StopService(){using(var service=new ServiceController(ServiceName)){if(service.Status!=ServiceControllerStatus.Stopped){service.Stop();service.WaitForStatus(ServiceControllerStatus.Stopped,TimeSpan.FromSeconds(20));}}}
    static void StartService(){using(var service=new ServiceController(ServiceName)){if(service.Status!=ServiceControllerStatus.Running)service.Start();service.WaitForStatus(ServiceControllerStatus.Running,TimeSpan.FromSeconds(20));}}
    static void Sc(string arguments){using(var process=Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory,"sc.exe"),arguments){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true})){var output=process.StandardOutput.ReadToEnd();var error=process.StandardError.ReadToEnd();if(!process.WaitForExit(20000)||process.ExitCode!=0)throw new IOException("sc-failed:"+output+error);}}
  }
}
