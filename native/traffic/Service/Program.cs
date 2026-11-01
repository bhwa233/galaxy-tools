using System;
using System.IO;
using System.Security.Principal;
using System.ServiceProcess;
using System.Threading;
using Spark.Traffic;

namespace Spark.TrafficService {
  sealed class TrafficWindowsService:ServiceBase {
    TrafficEngine engine;PipeServer server;DirectoryGuard codeGuard,dataGuard;
    public TrafficWindowsService(){ServiceName="spark233Traffic";CanStop=true;AutoLog=false;}
    protected override void OnStart(string[] args) {
      var data=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"spark233","traffic","data");
      codeGuard=DirectoryGuard.OpenProtected(AppDomain.CurrentDomain.BaseDirectory,true);dataGuard=DirectoryGuard.OpenProtected(data,false);
      engine=new TrafficEngine(data);server=new PipeServer(engine,"spark233-traffic-v1");
    }
    protected override void OnStop(){RequestAdditionalTime(20000);server?.Dispose();engine?.Dispose();dataGuard?.Dispose();codeGuard?.Dispose();}
  }
  static class Program {
    static int Main(string[] args) {
      if(args.Length==5&&args[0]=="--console"&&args[1]=="--isolate"&&args[3]=="--pipe"&&args[4].StartsWith("spark233-traffic-test-",StringComparison.Ordinal)) {
        var root=Path.GetFullPath(args[2]);if(!Path.IsPathRooted(args[2]))return 2;
        Directory.CreateDirectory(root);
        using(var identity=WindowsIdentity.GetCurrent())using(var engine=new TrafficEngine(root,identity.User.Value))using(var server=new PipeServer(engine,args[4]))using(var stop=new ManualResetEvent(false)) {
          Console.CancelKeyPress+=(_,ev)=>{ev.Cancel=true;stop.Set();};Console.Error.WriteLine("traffic-isolated-ready");
          var input=new Thread(()=>{while(Console.ReadLine()!=null){}stop.Set();}){IsBackground=true};input.Start();stop.WaitOne();return 0;
        }
      }
      if(args.Length!=0)return 2;
      try{ServiceBase.Run(new TrafficWindowsService());return 0;}catch(Exception ex){Console.Error.WriteLine("traffic-service:"+ex.GetType().Name);return 1;}
    }
  }
}
