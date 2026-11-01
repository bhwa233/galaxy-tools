using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;

namespace Spark.Traffic {
  sealed class ScopeState {
    public string Id;
    public bool Enabled;
    public int Generation;
    public readonly Dictionary<string, DateTime> Leases = new Dictionary<string, DateTime>();
    public readonly Dictionary<string, long[]> Window = new Dictionary<string, long[]>();
    public Dictionary<string, object> Snapshot;
    public readonly Queue<object> Recent = new Queue<object>();
    public Coverage Coverage;
    public DateTime CaptureStart=DateTime.MaxValue,CaptureEnd=DateTime.MinValue;
    public bool WasActive;
    public bool Active => Enabled && Leases.Values.Any(expiry => expiry > DateTime.UtcNow);
  }
  public sealed class TrafficEngine : IDisposable {
    readonly object sync = new object();
    readonly Dictionary<string, ScopeState> scopes = new Dictionary<string, ScopeState>();
    readonly Dictionary<string, BucketDelta> pending = new Dictionary<string, BucketDelta>();
    readonly Dictionary<string, Coverage> coverage = new Dictionary<string, Coverage>();
    readonly Dictionary<string,Coverage> ledgerCoverage=new Dictionary<string,Coverage>();
    readonly Dictionary<string, bool> grants = new Dictionary<string, bool>();
    readonly Dictionary<string, Dictionary<string, object>> udpFlows = new Dictionary<string, Dictionary<string, object>>();
    readonly Dictionary<string,int[]> endpointCounts=new Dictionary<string,int[]>();
    readonly NetworkEventSource source = new NetworkEventSource();
    readonly ProcessCatalog catalog = new ProcessCatalog();
    readonly HistoryStore history;
    readonly RunTotals runTotals;
    readonly string statePath;
    readonly string epoch = Guid.NewGuid().ToString("N");
    readonly Thread worker;
    readonly Stopwatch clock = Stopwatch.StartNew();
    DateTime lastPublish = DateTime.UtcNow, lastFlush = DateTime.UtcNow, lastRefresh = DateTime.MinValue, lastRetention = DateTime.MinValue;
    double lastMonotonic;
    long unresolved, snapshotId;
    long lastLoss;
    string pendingBatch = Guid.NewGuid().ToString("N"), storageError;
    BucketDelta[] retryDeltas;
    Coverage[] retryCoverage;
    long retryDurable;
    DateTime nextFlushAttempt=DateTime.MinValue;
    bool disposed;
    public string[] GrantedSids => grants.Keys.ToArray();
    public TrafficEngine(string dataRoot, string isolatedSid = null) {
      Directory.CreateDirectory(dataRoot);
      statePath = Path.Combine(dataRoot,"enabled.json");
      if (isolatedSid != null) grants[isolatedSid] = true;
      else {
        var permissions = Json.Decode(File.ReadAllText(Path.Combine(dataRoot,"grants.json")));
        foreach (var pair in permissions) { new System.Security.Principal.SecurityIdentifier(pair.Key); grants[pair.Key] = pair.Value is bool machine && machine; }
      }
      if (File.Exists(statePath)) {
        var saved = Json.Decode(File.ReadAllText(statePath));
        foreach (var pair in saved) {
          var details = pair.Value as Dictionary<string, object>; if (details == null) continue;
          scopes[pair.Key] = new ScopeState { Id = pair.Key, Enabled = Json.Bool(details,"enabled"), Generation = Json.Int(details,"generation",0,0,int.MaxValue) };
        }
      }
      history = new HistoryStore(dataRoot);
      runTotals = new RunTotals(dataRoot,catalog.All,DateTime.UtcNow);
      worker = new Thread(Run) { IsBackground = true, Name = "Traffic aggregation and history writer" }; worker.Start();
    }
    string Scope(string sid, Dictionary<string, object> request) {
      if (!grants.TryGetValue(sid,out var machine)) throw new UnauthorizedAccessException("caller-not-granted");
      var scope = Json.Str(request,"scope","own");
      if (scope != "own" && scope != "machine") throw new InvalidDataException("invalid-scope");
      if (scope == "machine" && !machine) throw new UnauthorizedAccessException("machine-scope-not-granted");
      foreach (var forbidden in new[]{"sid","scopeId","pid","imagePath","path","args","commandLine"}) if(request.ContainsKey(forbidden)) throw new InvalidDataException("untrusted-parameter:"+forbidden);
      return scope == "machine" ? "machine:"+sid : "own:" + sid;
    }
    static bool IsMachine(string id)=>id.StartsWith("machine:",StringComparison.Ordinal);
    static string Ledger(string id)=>IsMachine(id)?"machine":id;
    ScopeState Get(string id) { if (!scopes.TryGetValue(id,out var state)) scopes[id]=state=new ScopeState {Id=id}; return state; }
    void Save() => Json.AtomicWrite(statePath, scopes.ToDictionary(p=>p.Key,p=>(object)Json.Obj("enabled",p.Value.Enabled,"generation",p.Value.Generation)));
    // Reuse the published scope coverage: cumulative diagnostic counters do not
    // describe the current sampling window and must not keep a recovered window partial.
    public static Dictionary<string,object> DescribeQuality(Coverage window,bool running,string sourceError,string storageError,long eventsLost,long realtimeBuffersLost,long queueDropped,long parseErrors,long identityUnresolved) {
      var failure=sourceError??storageError;
      var state=!running?"unavailable":storageError!=null||window==null||window.State!="covered"?"partial":"good";
      var reason=failure??(!running?"collector-unavailable":window==null?"sampling-window-unavailable":window.State!="covered"?window.Reason:null);
      return Json.Obj("state",state,"eventsLost",Json.Decimal(eventsLost),"realtimeBuffersLost",Json.Decimal(realtimeBuffersLost),"queueDropped",Json.Decimal(queueDropped),"parseErrors",Json.Decimal(parseErrors),"identityUnresolved",Json.Decimal(identityUnresolved),"reason",reason);
    }
    Dictionary<string,object> Quality(ScopeState state) => DescribeQuality(state.Coverage,state.Active&&source.Running,!state.Active?"scope-inactive":source.Error,storageError,source.EventsLost,source.RealtimeBuffersLost,source.QueueDropped,source.ParseErrors,unresolved);
    public object Handle(string sid, string connection, Dictionary<string,object> request) {
      var operation=Json.Str(request,"op"); string id;
      lock(sync) {
        id=Scope(sid,request); var state=Get(id); var publicScope = IsMachine(id)?"machine":"own";
        switch(operation) {
          case "status": return Json.Obj("installed",true,"serviceAvailable",true,"source","etw","scope",publicScope,"grantedScopes",grants[sid]?new[]{"own","machine"}:new[]{"own"},"enabled",state.Enabled,"hasLease",state.Leases.TryGetValue(connection,out var expires)&&expires>DateTime.UtcNow,"collecting",state.Active&&source.Running,"collectorEpoch",epoch,"generation",state.Generation,"quality",Quality(state));
          case "scope.setEnabled":
            var enabled=Json.Bool(request,"enabled");
            if(enabled)source.ResetFailure();
            if(!enabled)Tick();
            if(state.Enabled!=enabled) { state.Enabled=enabled; state.Generation=checked(state.Generation+1); if(!enabled){state.Leases.Clear();EndCapture(state);} Save(); }
            if(!enabled){Tick();Flush();}
            return Json.Obj("enabled",state.Enabled,"generation",state.Generation,"collectorEpoch",epoch);
          case "lease.acquire":
            if(!state.Enabled) throw new InvalidOperationException("scope-disabled");
            state.Leases[connection]=DateTime.UtcNow.AddSeconds(15);
            return Json.Obj("generation",state.Generation,"collectorEpoch",epoch,"expiresInMs",15000);
          case "lease.renew":
            if(!state.Enabled || !state.Leases.ContainsKey(connection) || state.Leases[connection]<DateTime.UtcNow || Json.Int(request,"generation",-1,-1,int.MaxValue)!=state.Generation || Json.Str(request,"collectorEpoch")!=epoch) throw new InvalidOperationException("lease-expired");
            state.Leases[connection]=DateTime.UtcNow.AddSeconds(15); return Json.Obj("renewed",true);
          case "lease.release": Tick();state.Leases.Remove(connection);if(!state.Active)EndCapture(state);Tick();Flush(); return Json.Obj("released",true);
          case "flush": Flush(); return Json.Obj("ok",true,"durableThrough",history.DurableThrough==0?null:Json.Iso(Json.Time(history.DurableThrough)));
          case "snapshot":
            var snapshot=state.Snapshot==null?EmptySnapshot(publicScope,state):new Dictionary<string,object>(state.Snapshot);
            snapshot["quality"]=Quality(state); snapshot["collecting"]=state.Active&&source.Running;
            if(!state.Active) {snapshot["processes"]=new object[0];snapshot["totals"]=Totals(0,0,1000,false);}
            return snapshot;
          case "clearHistory":
            if(!Json.Bool(request,"confirm"))throw new InvalidOperationException("history-clear-confirmation-required");
            Flush(); history.Clear(Ledger(id)); foreach(var key in coverage.Where(c=>c.Value.Scope==Ledger(id)).Select(c=>c.Key).ToArray())coverage.Remove(key); ledgerCoverage.Remove(Ledger(id));state.Coverage=null;
            return Json.Obj("cleared",true,"scope",publicScope);
          case "connections": return Connections(id,request);
          case "icons": return Icons(id,request);
        }
      }
      if(operation=="history") {var value=history.Query(Ledger(id),request);value["scope"]=Json.Str(request,"scope","own");return value;}
      throw new InvalidDataException("unsupported-operation");
    }
    Dictionary<string,object> EmptySnapshot(string scope,ScopeState state) => Json.Obj("source","etw","scope",scope,"collectorEpoch",epoch,"snapshotId",Json.Decimal(snapshotId),"windowStart",Json.Iso(lastPublish),"windowEnd",Json.Iso(lastPublish),"elapsedMs",0,"quality",Quality(state),"coverage",new object[0],"processes",new object[0],"totals",Totals(0,0,1000,false),"recent",new object[0],"nextCursor",null);
    static Dictionary<string,object> Totals(long rx,long tx,double elapsed,bool measured=true) => Json.Obj("rxBytes",measured?Json.Decimal(rx):null,"txBytes",measured?Json.Decimal(tx):null,"rxBytesPerSec",measured?(object)(rx*1000d/elapsed):null,"txBytesPerSec",measured?(object)(tx*1000d/elapsed):null);
    void EndCapture(ScopeState state){if(state.WasActive){state.CaptureEnd=DateTime.UtcNow;state.WasActive=false;if(!scopes.Values.Any(value=>Ledger(value.Id)==Ledger(state.Id)&&value.Active))runTotals.MarkGap(Ledger(state.Id));}}
    public void Release(string connection) { lock(sync){Tick();foreach(var state in scopes.Values){state.Leases.Remove(connection);if(!state.Active)EndCapture(state);}Tick();Flush();} }
    void Run() {
      while(!disposed) {
        try {lock(sync){Tick();}} catch(Exception ex){storageError="collector-worker:"+ex.GetType().Name;}
        Thread.Sleep(100);
      }
    }
    void Tick() {
      var now=DateTime.UtcNow; var active=scopes.Values.Where(s=>s.Active).ToArray();
      foreach(var state in scopes.Values)if(state.Active&&!state.WasActive){state.CaptureStart=now;state.CaptureEnd=DateTime.MaxValue;state.WasActive=true;}else if(!state.Active)EndCapture(state);
      if(active.Length>0&&!source.Running&&source.Error==null)source.Start();
      if(active.Length==0&&source.Running)source.Stop();
      if(active.Length>0&&now-lastRefresh>TimeSpan.FromSeconds(2)) {
        catalog.Refresh();endpointCounts.Clear();
        try {
          var counts=EndpointTables.Counts();
          foreach(var process in catalog.All.Where(p=>p.End==DateTime.MaxValue)) {
            var current=ProcessCatalog.Inspect(process.Pid);
            if(current!=null&&current.Created==process.Created)endpointCounts[process.Id]=counts.TryGetValue(process.Pid,out var count)?count:new int[2];
          }
        }catch(System.ComponentModel.Win32Exception){}
        lastRefresh=now;
      }
      while(source.TryRead(out var ev)) {
        if(ev.EventId==1||ev.EventId==2){catalog.Observe(ev);continue;}
        if(ev.Timestamp>now.AddSeconds(2)||ev.Timestamp<now.AddMinutes(-5)){unresolved++;continue;}
        var process=catalog.Resolve(ev.Pid,ev.Timestamp);
        if(process==null){unresolved++;continue;}
        if(process.Sid==null)unresolved++;
        var booked=new HashSet<string>();
        foreach(var state in scopes.Values.Where(s=>ev.Timestamp>=s.CaptureStart&&ev.Timestamp<=s.CaptureEnd)) {
          if(!IsMachine(state.Id)&&(process.Sid==null||state.Id!="own:"+process.Sid))continue;
          if(!state.Window.TryGetValue(process.Id,out var bytes))state.Window[process.Id]=bytes=new long[2];
          bytes[ev.Receive?0:1]=checked(bytes[ev.Receive?0:1]+ev.Bytes);
          if(!booked.Add(Ledger(state.Id)))continue;
          runTotals.Observe(Ledger(state.Id),process,ev.Receive,ev.Bytes,ev.Timestamp,state.CaptureStart,now);
          foreach(var resolution in new[]{60,3600,86400}) {
            var time=Json.Unix(ev.Timestamp)/1000;var bucket=time-time%resolution;var key=state.Id+"|"+resolution+"|"+bucket+"|"+process.Id;
            key=Ledger(state.Id)+"|"+resolution+"|"+bucket+"|"+process.Id;
            if(!pending.TryGetValue(key,out var d))pending[key]=d=new BucketDelta {Scope=Ledger(state.Id),Resolution=resolution,Start=bucket,Process=process};
            if(ev.Receive)d.Rx=checked(d.Rx+ev.Bytes);else d.Tx=checked(d.Tx+ev.Bytes);
          }
        }
        if(ev.Udp)RememberUdp(process,ev);
      }
      if(clock.Elapsed.TotalMilliseconds-lastMonotonic>=1000) {
        var elapsed=clock.Elapsed.TotalMilliseconds-lastMonotonic;var wall=(now-lastPublish).TotalMilliseconds;var gap=elapsed>5000||Math.Abs(wall-elapsed)>2000;
        source.RefreshQuality();snapshotId++;var loss=source.EventsLost+source.RealtimeBuffersLost+source.ParseErrors+source.QueueDropped+unresolved;var windowLoss=loss!=lastLoss;lastLoss=loss;
        foreach(var group in scopes.Values.GroupBy(state=>Ledger(state.Id))) {
          var collecting=group.Any(state=>state.Active)&&source.Running;
          var observed=group.Where(state=>state.Active).Select(state=>state.CaptureStart).DefaultIfEmpty(now).Min();
          runTotals.Reconcile(group.Key,catalog.All,observed,collecting,now);
          if(!collecting||gap||windowLoss)runTotals.MarkGap(group.Key);
        }
        foreach(var state in scopes.Values) {
          var covered=state.Active&&source.Running&&!gap&&!windowLoss;
          var reason=gap?"sleep-or-clock-change":windowLoss?"collector-loss":!state.Active?"scope-inactive":source.Error??"";
          var coverageState=covered?"covered":"gap";
          if(state.Coverage==null||state.Coverage.State!=coverageState||state.Coverage.Reason!=reason) {
            state.Coverage=new Coverage {Scope=Ledger(state.Id),Epoch=epoch,Start=Json.Unix(lastPublish),End=Json.Unix(now),State=coverageState,Reason=reason};
          } else state.Coverage.End=Json.Unix(now);
          long rx=0,tx=0;var rows=new List<object>();
          foreach(var process in catalog.All.Where(p=>state.Active&&(IsMachine(state.Id)||p.Sid!=null&&state.Id=="own:"+p.Sid))) {
            var bytes=state.Window.TryGetValue(process.Id,out var observed)?observed:new long[2];
            var row=process.Describe();rx=checked(rx+bytes[0]);tx=checked(tx+bytes[1]);
            if(process.End!=DateTime.MaxValue)continue;
            foreach(var field in Totals(bytes[0],bytes[1],elapsed,covered))row[field.Key]=field.Value;
            foreach(var field in runTotals.Describe(Ledger(state.Id),process,state.CaptureStart,now))row[field.Key]=field.Value;
            row["tcpConnections"]=endpointCounts.TryGetValue(process.Id,out var count)?(object)count[0]:null;
            row["udpEndpoints"]=count==null?null:(object)count[1];
            row["udpFlows"]=source.Running?(object)udpFlows.Values.Count(v=>Json.Str(v,"processInstanceId")==process.Id):null;
            rows.Add(row);
          }
          var recent=Json.Obj("time",Json.Iso(now),"rxBytesPerSec",covered?(object)(rx*1000d/elapsed):null,"txBytesPerSec",covered?(object)(tx*1000d/elapsed):null);
          state.Recent.Enqueue(recent);while(state.Recent.Count>60)state.Recent.Dequeue();
          state.Snapshot=Json.Obj("source","etw","scope",IsMachine(state.Id)?"machine":"own","collectorEpoch",epoch,"snapshotId",Json.Decimal(snapshotId),"windowStart",Json.Iso(lastPublish),"windowEnd",Json.Iso(now),"elapsedMs",elapsed,"quality",Quality(state),"coverage",new[]{state.Coverage.Describe()},"processes",rows.OrderByDescending(r=>Convert.ToDouble(((Dictionary<string,object>)r)["rxBytesPerSec"])+Convert.ToDouble(((Dictionary<string,object>)r)["txBytesPerSec"])).ToArray(),"totals",Totals(rx,tx,elapsed,covered),"recent",state.Recent.ToArray(),"nextCursor",null);
          state.Window.Clear();
        }
        foreach(var group in scopes.Values.GroupBy(s=>Ledger(s.Id))) {
          var collecting=group.Any(s=>s.Active);var valid=collecting&&source.Running&&!gap&&!windowLoss;
          var reason=gap?"sleep-or-clock-change":windowLoss?"collector-loss":!collecting?"scope-inactive":source.Error??"";var kind=valid?"covered":"gap";
          if(!ledgerCoverage.TryGetValue(group.Key,out var current)||current.State!=kind||current.Reason!=reason)ledgerCoverage[group.Key]=current=new Coverage {Scope=group.Key,Epoch=epoch,Start=Json.Unix(lastPublish),State=kind,Reason=reason};
          current.End=Json.Unix(now);coverage[group.Key+"|"+current.Start]=current;
        }
        lastPublish=now;lastMonotonic=clock.Elapsed.TotalMilliseconds;
        foreach(var key in udpFlows.Where(p=>Json.Date(p.Value,"lastSeen",now)<now.AddSeconds(-30)).Select(p=>p.Key).ToArray())udpFlows.Remove(key);
      }
      if(now-lastFlush>=TimeSpan.FromSeconds(30)&&now>=nextFlushAttempt)Flush();
      if(now-lastRetention>=TimeSpan.FromMinutes(10)){history.Retain(now);lastRetention=now;}
    }
    void Flush() {
      try {
        do {
          if(retryDeltas==null) {
            retryDeltas=pending.Values.ToArray();pending.Clear();
            retryCoverage=coverage.Values.Select(c=>new Coverage {Scope=c.Scope,Epoch=c.Epoch,Start=c.Start,End=c.End,State=c.State,Reason=c.Reason}).ToArray();coverage.Clear();retryDurable=Json.Unix(lastPublish);
          }
          history.Commit(pendingBatch,retryDeltas,retryCoverage,retryDurable);
          retryDeltas=null;retryCoverage=null;pendingBatch=Guid.NewGuid().ToString("N");
        }while(pending.Count>0||coverage.Count>0);
        runTotals.Checkpoint(DateTime.UtcNow);
        lastFlush=DateTime.UtcNow;storageError=null;
      }catch(Exception ex){nextFlushAttempt=DateTime.UtcNow.AddSeconds(5);storageError="history-write:"+ex.GetType().Name;throw new IOException("history-flush-failed",ex);}
    }
    void RememberUdp(ProcessIdentity process,TrafficEvent ev) {
      if(udpFlows.Count>=10000)return;
      var length=ev.IPv6?16:4;var daddr=new byte[length];var saddr=new byte[length];Array.Copy(ev.Payload,8,daddr,0,length);Array.Copy(ev.Payload,8+length,saddr,0,length);
      var offset=8+length*2;var dp=ev.Payload[offset]*256+ev.Payload[offset+1];var sp=ev.Payload[offset+2]*256+ev.Payload[offset+3];
      // Manifest receive events still name destination/local and source/remote correctly.
      var local=new System.Net.IPAddress(ev.Receive?daddr:saddr).ToString();var remote=new System.Net.IPAddress(ev.Receive?saddr:daddr).ToString();var lp=ev.Receive?dp:sp;var rp=ev.Receive?sp:dp;
      var key=process.Id+"|"+local+":"+lp+"|"+remote+":"+rp;
      udpFlows[key]=Json.Obj("processInstanceId",process.Id,"protocol","udp","addressFamily",ev.IPv6?"ipv6":"ipv4","localAddress",local,"localPort",lp,"remoteAddress",remote,"remotePort",rp,"lastSeen",Json.Iso(ev.Timestamp));
    }
    ProcessIdentity AuthorizedProcess(string scope,Dictionary<string,object> request) {
      var process=catalog.Find(Json.Str(request,"processInstanceId"));
      if(process==null||!IsMachine(scope)&&(process.Sid==null||scope!="own:"+process.Sid))throw new UnauthorizedAccessException("process-not-visible");
      return process;
    }
    object Connections(string scope,Dictionary<string,object> request) {
      var process=AuthorizedProcess(scope,request);var kind=Json.Str(request,"kind","tcp");var limit=Json.Int(request,"limit",100,1,200);
      var current=Native.ReadProcess(process.Pid,process.Boot);
      if(current==null||current.Created!=process.Created)return Json.Obj("source","ip-helper","scope",IsMachine(scope)?"machine":"own","processInstanceId",process.Id,"endpoints",new object[0],"nextCursor",null);
      var endpoints=kind=="udp-observed"?udpFlows.Values.Where(v=>Json.Str(v,"processInstanceId")==process.Id).ToArray():EndpointTables.Read(process.Pid,kind,limit);
      return Json.Obj("source",kind=="udp-observed"?"etw":"ip-helper","scope",IsMachine(scope)?"machine":"own","processInstanceId",process.Id,"endpoints",endpoints,"nextCursor",null);
    }
    object Icons(string scope,Dictionary<string,object> request) {
      var result=new List<object>();
      if(request.TryGetValue("processInstanceIds",out var raw)&&raw is System.Collections.IEnumerable ids)foreach(var id in ids.Cast<object>().Take(20)) {
        var process=AuthorizedProcess(scope,Json.Obj("processInstanceId",Convert.ToString(id)));string png=null;
        if(process.Path!=null)try{using(var icon=System.Drawing.Icon.ExtractAssociatedIcon(process.Path))using(var bitmap=icon.ToBitmap())using(var stream=new MemoryStream()){bitmap.Save(stream,System.Drawing.Imaging.ImageFormat.Png);if(stream.Length<=8192)png=Convert.ToBase64String(stream.ToArray());}}catch(Exception ex)when(ex is IOException||ex is System.ArgumentException||ex is System.ComponentModel.Win32Exception){}
        result.Add(Json.Obj("processInstanceId",process.Id,"pngBase64",png));
      }
      return Json.Obj("icons",result);
    }
    public void Dispose() {
      disposed=true;worker.Join(10000);
      lock(sync){Tick();foreach(var state in scopes.Values){state.Leases.Clear();EndCapture(state);}Tick();source.Dispose();try{Flush();}finally{try{runTotals.Dispose();}finally{history.Dispose();udpFlows.Clear();}}}
    }
  }
}
