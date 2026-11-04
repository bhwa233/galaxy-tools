using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Spark.Traffic;

namespace Spark.TrafficClient {
  static class Program {
    static readonly object outputSync=new object(),rpcSync=new object(),taskSync=new object();
    static readonly Dictionary<string,Dictionary<string,object>> leases=new Dictionary<string,Dictionary<string,object>>();
    static readonly HashSet<string> canceled=new HashSet<string>();
    static readonly Dictionary<string,ManualResetEventSlim> inFlight=new Dictionary<string,ManualResetEventSlim>();
    static NamedPipeClientStream pipe;
    static StreamReader pipeReader;
    static StreamWriter pipeWriter;
    static string session,ownerFingerprint;
    static bool stopping;
    static Timer heartbeat;
    static int desktopHost;
    static string pipeName="spark233-traffic-v1";
    static int Main(string[] args) {
      if(args.Length==3&&args[0]=="--bridge"&&args[1]=="--isolated-pipe"&&args[2].StartsWith("spark233-traffic-test-",StringComparison.Ordinal))pipeName=args[2];
      else if(args.Length!=1||args[0]!="--bridge"){Console.Error.WriteLine("usage: spark233.TrafficClient.exe --bridge");return 2;}
      Console.InputEncoding=new UTF8Encoding(false,true);Console.OutputEncoding=new UTF8Encoding(false);
      desktopHost=ProcessActions.DesktopHost();
      heartbeat=new Timer(_=>Renew(),null,5000,5000);
      try {
        for(;;) {
          var line=Json.ReadLine(Console.In,1048576);if(line==null)break;
          var request=Json.Decode(line);var type=Json.Str(request,"type");var id=Json.Str(request,"requestId");
          if(Json.Int(request,"protocol",0,0,1)!=1||id.Length==0||id.Length>100)throw new InvalidDataException("invalid-native-protocol");
          if(type=="init") {
            if(session!=null)throw new InvalidDataException("already-initialized");
            session=Json.Str(request,"sessionId");ownerFingerprint=Json.Encode(Json.Child(request,"owner"));
            Respond(request,true,Json.Obj("ready",true,"pid",Process.GetCurrentProcess().Id));continue;
          }
          if(session==null||Json.Str(request,"sessionId")!=session||Json.Encode(Json.Child(request,"owner"))!=ownerFingerprint)throw new InvalidDataException("native-identity-mismatch");
          if(type=="cancel"){lock(taskSync)canceled.Add(id);continue;}
          if(type=="prepareStop"||type=="stop") {
            WaitTasks();
            if(type=="prepareStop") {
              try {lock(rpcSync){foreach(var scope in leases.Keys.ToArray())Rpc(Json.Obj("op","flush","scope",scope));}Respond(request,true,Json.Obj("ok",true));}
              catch(Exception ex){Respond(request,true,Json.Obj("ok",false,"reason",SafeError(ex)));}
            } else {
              stopping=true;Release();Respond(request,true,Json.Obj("stopped",true));return 0;
            }
            continue;
          }
          if(type!="query"&&type!="activate"){Respond(request,false,null,"unsupported-native-request");continue;}
          var completion=new ManualResetEventSlim();
          lock(taskSync){if(inFlight.Count>=32){Respond(request,false,null,"too-many-requests");continue;}inFlight[id]=completion;}
          ThreadPool.QueueUserWorkItem(_=>{
            try {
              var activation=Json.Child(request,"activation");var parameters=Json.Child(activation,"parameters");
              var command=Json.Str(parameters,"command",Json.Str(activation,"commandId","status"));
              var value=Execute(command,parameters);
              lock(taskSync)if(!canceled.Contains(id))Respond(request,true,value);
            }catch(Exception ex){lock(taskSync)if(!canceled.Contains(id))Respond(request,false,null,SafeError(ex));}
            finally{lock(taskSync){inFlight.Remove(id);canceled.Remove(id);}completion.Set();}
          });
        }
        return 0;
      }catch(Exception ex){Console.Error.WriteLine(SafeError(ex));return 1;}
      finally{stopping=true;heartbeat?.Dispose();WaitTasks();Release();}
    }
    static void WaitTasks() {ManualResetEventSlim[] tasks;lock(taskSync)tasks=inFlight.Values.ToArray();foreach(var task in tasks)task.Wait(12000);}
    static object Execute(string command,Dictionary<string,object> parameters) {
      if(command=="install"||command=="grantMachine")return Install(command);
      var scope=Json.Str(parameters,"scope","own");if(scope!="own"&&scope!="machine")throw new InvalidDataException("invalid-scope");
      if(command=="process.action") {
        var action=Json.Str(parameters,"action");
        if(action!="reveal"&&action!="properties"&&action!="terminate")throw new InvalidDataException("unsupported-process-action");
        if(action=="terminate"&&!Json.Bool(parameters,"confirmed"))throw new InvalidDataException("process-confirmation-required");
        var selected=Json.Str(parameters,"processInstanceId");
        // Reuse the existing service's per-instance connection authorization.
        // The service never gains a termination endpoint or a new protocol.
        lock(rpcSync) {
          var authorized=Rpc(Json.Obj("op","connections","scope",scope,"processInstanceId",selected,"kind","tcp","limit",1));
          if(Json.Str(authorized,"processInstanceId")!=selected)throw new InvalidOperationException("process-not-visible");
        }
        var parts=selected.Split(':');
        if(parts.Length!=3||!Guid.TryParseExact(parts[0],"N",out _)||!int.TryParse(parts[1],out var pid)||!long.TryParse(parts[2],out var created))throw new InvalidDataException("process-identity-unavailable");
        var target=ProcessCatalog.Inspect(pid);
        if(target==null||target.Created!=created)throw new InvalidOperationException("process-exited");
        using(var caller=WindowsIdentity.GetCurrent())if(scope=="own"&&target.Sid!=caller.User?.Value)throw new InvalidOperationException("process-not-visible");
        return ProcessActions.Run(target,action,desktopHost);
      }
      lock(rpcSync) {
        if(command=="status") {
          Dictionary<string,object> status;
          try {status=Rpc(Json.Obj("op","status","scope",scope));}
          catch(Exception ex)when(ex is IOException||ex is TimeoutException||ex is System.ComponentModel.Win32Exception) {
            Disconnect();return Json.Obj("installed",Installed(),"serviceAvailable",false,"source","etw","scope",scope,"enabled",false,"hasLease",false,"collecting",false,"grantedScopes",new object[0],"collectorEpoch",null,"generation",0,"quality",Json.Obj("state","unavailable","eventsLost","0","realtimeBuffersLost","0","queueDropped","0","parseErrors","0","identityUnresolved","0","reason","service-unavailable"));
          }
          return status;
        }
        if(command=="enable") {
          Rpc(Json.Obj("op","scope.setEnabled","scope",scope,"enabled",true));leases[scope]=Rpc(Json.Obj("op","lease.acquire","scope",scope));
          return Rpc(Json.Obj("op","status","scope",scope));
        }
        if(command=="disable") {Rpc(Json.Obj("op","scope.setEnabled","scope",scope,"enabled",false));leases.Remove(scope);return Rpc(Json.Obj("op","status","scope",scope));}
        if(command!="snapshot"&&command!="history"&&command!="connections"&&command!="icons"&&command!="clearHistory")throw new InvalidDataException("unsupported-command");
        var request=new Dictionary<string,object>(parameters);request.Remove("command");request["op"]=command;request["scope"]=scope;
        return Rpc(request);
      }
    }
    static bool Installed() {
      var root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"spark233","traffic","data");
      return Directory.Exists(root);
    }
    static object Install(string command) {
      if(pipeName!="spark233-traffic-v1")throw new InvalidOperationException("install-not-allowed-in-isolated-mode");
      var executable=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"spark233.TrafficSetup.exe");
      if(!File.Exists(executable))throw new FileNotFoundException("traffic-installer-unavailable");
      using(var self=Process.GetCurrentProcess())using(var helper=Process.Start(new ProcessStartInfo(executable,(command=="install"?"--install":"--grant-machine")+" --caller-pid "+self.Id+" --caller-created "+self.StartTime.ToUniversalTime().ToFileTimeUtc()){UseShellExecute=true,Verb="runas",WindowStyle=ProcessWindowStyle.Hidden})) {
        if(helper==null)throw new IOException("installer-start-failed");
        if(!helper.WaitForExit(110000))throw new TimeoutException("installer-still-running");
        if(helper.ExitCode!=0)throw new InvalidOperationException("流量服务安装失败："+InstallerDiagnostics.Describe(helper.ExitCode)+"（错误代码："+helper.ExitCode+"）");
      }
      lock(rpcSync){Disconnect();}return Json.Obj("installed",true,"machineGranted",command=="grantMachine");
    }
    static void Renew() {
      if(stopping||!Monitor.TryEnter(rpcSync))return;
      try {
        foreach(var pair in leases.ToArray()) {
          try{Rpc(Json.Obj("op","lease.renew","scope",pair.Key,"generation",pair.Value["generation"],"collectorEpoch",pair.Value["collectorEpoch"]));}
          catch(Exception){leases.Remove(pair.Key);Disconnect();}
        }
      }finally{Monitor.Exit(rpcSync);}
    }
    static void Release() {
      lock(rpcSync){foreach(var scope in leases.Keys.ToArray())try{Rpc(Json.Obj("op","lease.release","scope",scope));}catch(Exception){}leases.Clear();Disconnect();}
    }
    static Dictionary<string,object> Rpc(Dictionary<string,object> request) {
      if(pipe==null) {
        pipe=new NamedPipeClientStream(".",pipeName,PipeDirection.InOut,PipeOptions.None,TokenImpersonationLevel.Identification);
        try {pipe.Connect(1500);ServerIdentity.Verify(pipe,pipeName!="spark233-traffic-v1");}catch{Disconnect();throw;}
        pipe.ReadMode=PipeTransmissionMode.Message;
        pipeReader=new StreamReader(pipe,new UTF8Encoding(false,true),false,4096,true);pipeWriter=new StreamWriter(pipe,new UTF8Encoding(false),4096,true){AutoFlush=true,NewLine="\n"};
      }
      request["v"]=1;request["id"]=Guid.NewGuid().ToString("N");
      var activePipe=pipe;
      using(var timeout=new Timer(_=>{try{activePipe.Dispose();}catch(ObjectDisposedException){}},null,7000,Timeout.Infinite)) {
        try {
          pipeWriter.WriteLine(Json.Encode(request));var line=Json.ReadLine(pipeReader,65536);if(line==null)throw new IOException("service-disconnected");
          var response=Json.Decode(line);if(Json.Str(response,"id")!=Json.Str(request,"id"))throw new IOException("service-response-mismatch");
          if(!Json.Bool(response,"ok"))throw new InvalidOperationException(Json.Str(response,"error","service-error"));
          return Json.Child(response,"data");
        }catch(IOException){Disconnect();throw;}catch(ObjectDisposedException){Disconnect();throw new IOException("service-timeout");}
      }
    }
    static void Disconnect(){try{pipeReader?.Dispose();}catch(IOException){}try{pipeWriter?.Dispose();}catch(Exception ex)when(ex is IOException||ex is ObjectDisposedException){}pipe?.Dispose();pipeReader=null;pipeWriter=null;pipe=null;}
    static string SafeError(Exception ex) {
      if(ex is InvalidOperationException||ex is InvalidDataException)return ex.Message.Substring(0,Math.Min(1024,ex.Message.Length));
      if(ex is IOException&&ex.Message.Length>0&&ex.Message.Length<=100&&ex.Message.All(c=>c>='a'&&c<='z'||c>='0'&&c<='9'||c=='-'))return ex.Message;
      return "traffic-native:"+ex.GetType().Name;
    }
    static void Respond(Dictionary<string,object> request,bool ok,object value,string error=null) {
      var response=Json.Obj("protocol",1,"owner",request["owner"],"sessionId",request["sessionId"],"requestId",request["requestId"],"type","response","ok",ok);
      if(ok)response["value"]=value;else response["error"]=error;
      lock(outputSync)Console.WriteLine(Json.Encode(response));
    }
  }
}
