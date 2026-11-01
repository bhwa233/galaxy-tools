using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Text;
using System.Reflection;
using Spark.Traffic;

namespace Spark.TrafficVerification {
  static class Program {
    static void Check(bool condition,string name){if(!condition)throw new InvalidOperationException("verification-failed:"+name);}
    static void CheckAcl(string sddl,bool code,bool allowed) {var security=new DirectorySecurity();security.SetSecurityDescriptorSddlForm(sddl);var accepted=true;try{DirectoryGuard.ValidateSecurity(security,code);}catch(UnauthorizedAccessException){accepted=false;}Check(accepted==allowed,"protected-directory-acl-boundary");}
    static TrafficEvent ProcessEvent(int pid,long created,DateTime time) {var payload=new byte[12];Array.Copy(BitConverter.GetBytes(pid),payload,4);Array.Copy(BitConverter.GetBytes(created),0,payload,4,8);return new TrafficEvent {EventId=1,Pid=pid,Timestamp=time,Payload=payload};}
    static ProcessIdentity RunProcess(int pid,DateTime start,string sid) => new ProcessIdentity {Id="verify-run:"+pid+":"+start.ToFileTimeUtc(),Boot="verify-run",Pid=pid,Created=start.ToFileTimeUtc(),Sid=sid,Path=@"C:\isolated\run.exe",Name="run.exe",Start=start};
    static void VerifyRunTotals(string root,string sid,DateTime now) {
      var scope="own:"+sid;var observed=now.AddSeconds(-20);var main=RunProcess(2147483500,now.AddSeconds(-10),sid);var child=RunProcess(2147483501,now.AddSeconds(-5),sid);string run;
      using(var history=new HistoryStore(root)) {
        using(var totals=new RunTotals(root,new ProcessIdentity[0],now)) {
          totals.Reconcile(scope,new[]{main,child},observed,true,now);
          totals.Observe(scope,main,true,100,now,observed,now);totals.Observe(scope,child,true,200,now,observed,now);totals.Observe(scope,child,false,50,now,observed,now);
          var initial=totals.Describe(scope,main,observed,now);run=Json.Str(initial,"appRunId");
          Check(Json.Str(initial,"appRunRxBytes")=="300"&&Json.Str(initial,"appRunTxBytes")=="50"&&Json.Str(initial,"appRunCoverage")=="complete","run-aggregates-process-members-with-exact-byte-counts");
          var late=RunProcess(2147483502,observed.AddSeconds(-10),sid);totals.Reconcile(scope,new[]{main,child,late},observed,true,now);
          Check(Json.Str(totals.Describe(scope,main,observed,now),"appRunCoverage")=="gap","late-discovered-older-member-preserves-pre-monitoring-gap");late.End=now.AddMilliseconds(500);
          var unresolved=RunProcess(2147483503,now.AddSeconds(-2),sid);unresolved.Path=null;totals.Observe(scope,unresolved,true,13,now,observed,now);unresolved.Path=@"C:\isolated\resolved.exe";
          var resolved=totals.Describe(scope,unresolved,observed,now);Check(Json.Str(resolved,"runRxBytes")=="13"&&Json.Str(resolved,"appRunRxBytes")=="13","resolved-process-metadata-transfers-observed-run-counts-once");unresolved.End=now;
          child.End=now.AddSeconds(1);totals.Reconcile(scope,new[]{main},observed,true,now.AddMinutes(6));
          Check(Json.Str(totals.Describe(scope,main,observed,now.AddMinutes(6)),"appRunRxBytes")=="300","retiring-exited-child-does-not-reduce-live-application-total");
          totals.Observe(scope,main,true,9007199254740993L,now.AddMinutes(6),observed,now.AddMinutes(6));
          totals.MarkGap(scope);totals.Observe(scope,main,false,7,now.AddMinutes(6),observed,now.AddMinutes(6));
          var gap=totals.Describe(scope,main,observed,now.AddMinutes(6));
          Check(Json.Str(gap,"appRunRxBytes")=="9007199254741293"&&Json.Str(gap,"appRunTxBytes")=="57"&&Json.Str(gap,"appRunCoverage")=="gap","gap-keeps-only-observed-run-bytes-without-rounding-or-estimation");
          totals.Checkpoint(now.AddMinutes(6));history.Clear(scope);
        }
        using(var totals=new RunTotals(root,new[]{main},now.AddMinutes(6))) {
          var restored=totals.Describe(scope,main,observed,now.AddMinutes(6));
          Check(Json.Str(restored,"appRunId")==run&&Json.Str(restored,"appRunRxBytes")=="9007199254741293"&&Json.Str(restored,"runRxBytes")=="9007199254741093"&&Json.Str(restored,"appRunCoverage")=="gap","checkpoint-restores-same-live-run-independent-of-cleared-history");
          main.End=now.AddMinutes(6).AddSeconds(1);totals.Reconcile(scope,new ProcessIdentity[0],observed,true,main.End);
          var restarted=RunProcess(main.Pid,main.End.AddSeconds(1),sid);totals.Reconcile(scope,new[]{restarted},observed,true,restarted.Start);
          var fresh=totals.Describe(scope,restarted,observed,restarted.Start);
          Check(Json.Str(fresh,"appRunId")!=run&&Json.Str(fresh,"appRunRxBytes")=="0","all-members-exit-and-pid-reuse-start-a-new-zero-run");
          totals.Observe(scope,restarted,true,9,restarted.Start,observed,restarted.Start);
          totals.Observe(scope,main,true,11,main.End.AddMilliseconds(-1),observed,restarted.Start);
          Check(Json.Str(totals.Describe(scope,restarted,observed,restarted.Start),"appRunRxBytes")=="9"&&!Json.Bool(totals.Describe(scope,main,observed,restarted.Start),"alive"),"late-exited-process-event-does-not-credit-restarted-application");
          var denied=false;try{totals.Describe("own:S-1-5-21-0-0-0-9999",restarted,observed,restarted.Start);}catch(UnauthorizedAccessException){denied=true;}
          Check(denied,"run-counts-preserve-authenticated-process-scope");
          totals.Checkpoint(restarted.Start);main=restarted;
        }
        var reused=RunProcess(main.Pid,main.Start.AddSeconds(2),sid);
        using(var totals=new RunTotals(root,new[]{reused},reused.Start))Check(Json.Str(totals.Describe(scope,reused,observed,reused.Start),"runRxBytes")=="0","checkpoint-does-not-reuse-an-old-pid-generation");
      }
    }
    static void VerifySharedRunScopes(TrafficEngine engine,string user,string another) {
      engine.Handle(user,"run-own",Json.Obj("op","scope.setEnabled","scope","own","enabled",true));engine.Handle(user,"run-own",Json.Obj("op","lease.acquire","scope","own"));
      foreach(var caller in new[]{user,another}){engine.Handle(caller,"run-"+caller,Json.Obj("op","scope.setEnabled","scope","machine","enabled",true));engine.Handle(caller,"run-"+caller,Json.Obj("op","lease.acquire","scope","machine"));}
      var flags=BindingFlags.NonPublic|BindingFlags.Instance;var gate=typeof(TrafficEngine).GetField("sync",flags).GetValue(engine);
      lock(gate) {
        var tick=typeof(TrafficEngine).GetMethod("Tick",flags);tick.Invoke(engine,null);var at=DateTime.UtcNow;
        var catalog=(ProcessCatalog)typeof(TrafficEngine).GetField("catalog",flags).GetValue(engine);var pid=2147483499;catalog.Observe(ProcessEvent(pid,at.AddSeconds(-1).ToFileTimeUtc(),at.AddSeconds(-1)));var process=catalog.Resolve(pid,at);process.Sid=user;process.Path=@"C:\isolated\scoped-run.exe";
        var source=(NetworkEventSource)typeof(TrafficEngine).GetField("source",flags).GetValue(engine);typeof(NetworkEventSource).GetMethod("Enqueue",flags).Invoke(source,new object[]{new TrafficEvent {EventId=11,Pid=pid,Receive=true,Bytes=123,Timestamp=at,Payload=new byte[20]}});tick.Invoke(engine,null);
        var totals=(RunTotals)typeof(TrafficEngine).GetField("runTotals",flags).GetValue(engine);
        Check(Json.Str(totals.Describe("machine",process,at,at),"runRxBytes")=="123"&&Json.Str(totals.Describe("own:"+user,process,at,at),"runRxBytes")=="123","same-etw-event-counts-once-per-ledger-despite-multiple-machine-leases");
      }
    }
    static int Main(string[] args) {
      try {
        if(args.Length!=1||!Path.IsPathRooted(args[0])||Directory.Exists(args[0]))throw new ArgumentException("fresh-absolute-isolated-root-required");
        Directory.CreateDirectory(args[0]);
        const string trusted="O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
        CheckAcl(trusted+"(A;OICI;0x1200a9;;;BU)",true,true);
        CheckAcl(trusted+"(A;OICI;0x1200a9;;;AU)",true,true);
        CheckAcl(trusted+"(A;OICI;FA;;;AU)",true,false);
        CheckAcl(trusted+"(A;OICI;0x1200a9;;;AU)",false,false);
        CheckAcl("O:AUG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",true,false);
        // A recovered real sampling window used to remain partial forever
        // because a previous unresolved event stayed in the lifetime counters.
        var missingWindow=new Coverage {State="gap",Reason="collector-loss"};
        var partial=TrafficEngine.DescribeQuality(missingWindow,true,null,null,0,0,0,0,1);
        Check(Json.Str(partial,"state")=="partial"&&Json.Str(partial,"reason")=="collector-loss","current-window-loss-is-partial");
        var recovered=TrafficEngine.DescribeQuality(new Coverage {State="covered",Reason=""},true,null,null,0,0,0,0,1);
        Check(Json.Str(recovered,"state")=="good"&&Json.Str(recovered,"identityUnresolved")=="1"&&recovered["reason"]==null,"covered-window-recovers-with-diagnostics-retained");
        var storageFailed=TrafficEngine.DescribeQuality(new Coverage {State="covered",Reason=""},true,null,"history-write:IOException",0,0,0,0,1);
        Check(Json.Str(storageFailed,"state")=="partial"&&Json.Str(storageFailed,"reason")=="history-write:IOException","covered-window-does-not-hide-storage-failure");
        var catalog=new ProcessCatalog();var now=DateTime.UtcNow;const int reusedPid=2147483600;
        var older=now.AddSeconds(-3).ToFileTimeUtc();var newer=now.AddSeconds(-1).ToFileTimeUtc();
        catalog.Observe(ProcessEvent(reusedPid,newer,now.AddSeconds(-1)));
        catalog.Observe(ProcessEvent(reusedPid,older,now.AddSeconds(-3)));
        Check(catalog.Resolve(reusedPid,now)?.Created==newer,"late-old-start-keeps-new-generation-alive");
        Check(catalog.Resolve(reusedPid,now.AddSeconds(-2))?.Created==older,"event-time-selects-old-generation");
        var process=catalog.Resolve(reusedPid,now);var time=Json.Unix(now)/1000;var bucket=time-time%60;
        var first=Json.Obj("from",Json.Iso(Json.Time(bucket*1000)),"to",Json.Iso(now.AddSeconds(1)),"resolutionSec",60);
        var database=Path.Combine(args[0],"history");const string scopeA="own:S-1-5-21-100-200-300-1001",scopeB="own:S-1-5-21-100-200-300-1002";
        using(var history=new HistoryStore(database)) {
          var delta=new BucketDelta {Scope=scopeA,Resolution=60,Start=bucket,Process=process,Rx=9007199254740993L,Tx=17};
          var cover=new Coverage {Scope=scopeA,Epoch="verify",Start=Json.Unix(now.AddSeconds(-10)),End=Json.Unix(now),State="covered",Reason=""};
          history.Commit("retry-batch",new[]{delta},new[]{cover},Json.Unix(now));
          history.Commit("retry-batch",new[]{delta},new[]{cover},Json.Unix(now));
          var rows=(List<object>)history.Query(scopeA,first)["rows"];Check(rows.Count==1,"one-durable-fact");
          Check((string)((Dictionary<string,object>)rows[0])["rxBytes"]=="9007199254740993","retry-idempotence-and-64bit-json");
          Check(((List<object>)history.Query(scopeB,first)["rows"]).Count==0,"scope-ledger-isolation");
        }
        using(var history=new HistoryStore(database)) {
          Check(((List<object>)history.Query(scopeA,first)["rows"]).Count==1,"closed-process-survives-writer-restart");
          history.Clear(scopeB);Check(((List<object>)history.Query(scopeA,first)["rows"]).Count==1,"clear-only-requested-scope");
        }
        using(var identity=WindowsIdentity.GetCurrent()) {
          var user=identity.User.Value;const string another="S-1-5-21-100-200-300-1002";var root=Path.Combine(args[0],"engine");Directory.CreateDirectory(root);Json.AtomicWrite(Path.Combine(root,"grants.json"),Json.Obj(user,true,another,true));
          VerifyRunTotals(Path.Combine(args[0],"run-totals"),user,now);
          // Real history queries failed with row-too-large because all coverage
          // intervals were repeated outside the paginated rows. The old 1,000
          // interval cap also silently lost coverage near the end of a range.
          var historyStart=Json.Unix(now.AddHours(-1))/60000*60000;var historyEnd=historyStart+2400000;
          var intervals=Enumerable.Range(0,2400).Select(index=>new Coverage {Scope="own:"+user,Epoch="history-pages",Start=historyStart+index*1000,End=historyStart+(index+1)*1000,State=index%2==0?"covered":"gap",Reason=index%2==0?"":"collector-loss"}).ToList();
          intervals.Add(new Coverage {Scope="own:"+user,Epoch="overlapping-epoch",Start=historyStart+250,End=historyStart+500,State="gap",Reason="collector-loss"});
          var deltas=Enumerable.Range(0,250).Select(index=>new BucketDelta {Scope="own:"+user,Resolution=60,Start=historyStart/1000,Rx=3,Tx=7,Process=new ProcessIdentity {Id="verify-history:"+index,Pid=10000+index,Created=older,Boot="verify",Sid=user,Name="隔离程序 "+index,Path=@"C:\isolated\app-"+index+".exe",Start=now.AddHours(-2)}}).ToArray();
          using(var history=new HistoryStore(root))history.Commit("history-pages",deltas,intervals,historyEnd);
          using(var engine=new TrafficEngine(root)) {
            var historyRequest=Json.Obj("v",1,"op","history","scope","own","from",Json.Iso(Json.Time(historyStart)),"to",Json.Iso(Json.Time(historyEnd+30000)),"resolutionSec",60,"limit",200);
            var result=(Dictionary<string,object>)engine.Handle(user,"history-verification",historyRequest);
            var summary=Json.Child(result,"coverageSummary");
            Check(Json.Str(summary,"state")=="gap"&&Json.Str(summary,"coveredMs")=="1199750"&&Json.Str(summary,"gapMs")=="1200250","all-history-intervals-count-with-overlapping-gaps");
            Check(Json.Str(summary,"end")==Json.Iso(Json.Time(historyEnd)),"pending-history-tail-is-not-a-gap");
            var smallRange=new Dictionary<string,object>(historyRequest);smallRange["from"]=Json.Iso(Json.Time(historyStart+2000));smallRange["to"]=Json.Iso(Json.Time(historyStart+3000));
            Check(Json.Str(Json.Child((Dictionary<string,object>)engine.Handle(user,"history-verification",smallRange),"coverageSummary"),"state")=="complete","fully-observed-history-range-is-complete");
            smallRange["from"]=Json.Iso(Json.Time(historyEnd+1000));smallRange["to"]=Json.Iso(Json.Time(historyEnd+2000));
            Check(Json.Str(Json.Child((Dictionary<string,object>)engine.Handle(user,"history-verification",smallRange),"coverageSummary"),"state")=="unavailable","unpersisted-history-range-is-unavailable");
            var pipeName="spark233-traffic-verify-"+Guid.NewGuid().ToString("N");
            using(var server=new PipeServer(engine,pipeName))
            using(var pipe=new NamedPipeClientStream(".",pipeName,PipeDirection.InOut,PipeOptions.None,System.Security.Principal.TokenImpersonationLevel.Identification)) {
              pipe.Connect(5000);pipe.ReadMode=PipeTransmissionMode.Message;
              using(var reader=new StreamReader(pipe,new UTF8Encoding(false,true),false,4096,true))
              using(var writer=new StreamWriter(pipe,new UTF8Encoding(false),4096,true){AutoFlush=true,NewLine="\n"}) {
                var received=new List<Dictionary<string,object>>();var cursor="";var seen=new HashSet<string>();
                do {
                  historyRequest["id"]=Guid.NewGuid().ToString("N");historyRequest["cursor"]=cursor;
                  writer.WriteLine(Json.Encode(historyRequest));var reply=Json.Decode(Json.ReadLine(reader,65536));
                  Check(Json.Bool(reply,"ok"),"fragmented-history-fits-real-pipe-frames");
                  var page=Json.Child(reply,"data");received.AddRange(((IEnumerable)page["rows"]).Cast<Dictionary<string,object>>());
                  cursor=Json.Str(page,"nextCursor");Check(cursor.Length==0||seen.Add(cursor),"history-cursor-makes-progress");
                }while(cursor.Length>0);
                Check(received.Count==deltas.Length&&received.Select(row=>Json.Str(row,"processInstanceId")).Distinct().Count()==deltas.Length&&received.Sum(row=>long.Parse(Json.Str(row,"rxBytes")))==deltas.Sum(delta=>delta.Rx),"history-pages-preserve-all-processes-and-byte-totals");
                historyRequest.Remove("cursor");historyRequest["id"]=Guid.NewGuid().ToString("N");writer.WriteLine(Json.Encode(historyRequest));
                var firstPage=Json.Decode(Json.ReadLine(reader,65536));Check(Json.Bool(firstPage,"ok"),"history-first-page-ready-for-scope-fence");
                historyRequest["cursor"]=Json.Str(Json.Child(firstPage,"data"),"nextCursor");historyRequest["scope"]="machine";historyRequest["id"]=Guid.NewGuid().ToString("N");writer.WriteLine(Json.Encode(historyRequest));
                var denied=Json.Decode(Json.ReadLine(reader,65536));Check(!Json.Bool(denied,"ok")&&Json.Str(denied,"error")=="cursor-expired","history-cursor-cannot-cross-query-scope");
              }
            }
            engine.Handle(user,"a",Json.Obj("op","scope.setEnabled","scope","own","enabled",true));
            var old=(Dictionary<string,object>)engine.Handle(user,"a",Json.Obj("op","lease.acquire","scope","own"));
            engine.Handle(user,"a",Json.Obj("op","scope.setEnabled","scope","own","enabled",false));
            engine.Handle(user,"a",Json.Obj("op","scope.setEnabled","scope","own","enabled",true));
            var refused=false;try{engine.Handle(user,"a",Json.Obj("op","lease.renew","scope","own","generation",old["generation"],"collectorEpoch",old["collectorEpoch"]));}catch(InvalidOperationException){refused=true;}
            Check(refused,"disable-revokes-old-generation");
            engine.Handle(user,"a",Json.Obj("op","scope.setEnabled","scope","machine","enabled",true));
            engine.Handle(another,"b",Json.Obj("op","scope.setEnabled","scope","machine","enabled",true));
            engine.Handle(another,"b",Json.Obj("op","lease.acquire","scope","machine"));
            engine.Handle(user,"a",Json.Obj("op","scope.setEnabled","scope","machine","enabled",false));
            Check(Json.Bool((Dictionary<string,object>)engine.Handle(another,"b",Json.Obj("op","status","scope","machine")),"hasLease"),"machine-intent-does-not-revoke-another-user");
            VerifySharedRunScopes(engine,user,another);
          }
        }
        Console.WriteLine(Json.Encode(Json.Obj("ok",true,"root",args[0],"checks",new[]{"protected directory read-execute ACL compatibility without write or data leakage","current quality recovers after loss while retaining cumulative diagnostics and storage failures","late PID generations","64-bit and idempotent SQLite commit","scope history isolation","durability after restart","bounded complete history coverage and real pipe pagination without row loss","history cursor query-scope isolation","old lease generation revoked","machine intent per authenticated user","application run lifecycle retains retired children and isolates restarted generations","run checkpoints survive reconnect and cleared history with exact observed bytes","shared machine leases count each event once per ledger"})));return 0;
      }catch(Exception ex){Console.Error.WriteLine(ex);return 1;}
    }
  }
}
