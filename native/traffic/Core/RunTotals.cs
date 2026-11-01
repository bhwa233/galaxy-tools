using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.Data.Sqlite;

namespace Spark.Traffic {
  // Reuse the existing ETW identities and SQLite dependency. A renderer or a
  // history-bucket sum cannot retain exited children or survive bridge retries.
  // This store owns only current application runs; history retention is separate.
  public sealed class RunTotals : IDisposable {
    sealed class AppRun {
      public string Id, Key, Scope;
      public DateTime Started, Observed, End = DateTime.MaxValue;
      public long Rx, Tx;
      public bool Gap;
    }
    sealed class Instance {
      public string Scope;
      public string GroupedPath, GroupedSid, GroupKey;
      public ProcessIdentity Process;
      public AppRun App;
      public DateTime Observed;
      public long Rx, Tx;
    }
    readonly SqliteConnection writer;
    readonly Dictionary<string, AppRun> applications = new Dictionary<string, AppRun>();
    readonly Dictionary<string, Instance> instances = new Dictionary<string, Instance>();
    readonly Dictionary<string, Dictionary<string, Instance>> byScope = new Dictionary<string, Dictionary<string, Instance>>(StringComparer.Ordinal);
    readonly Dictionary<string, List<AppRun>> byApplication = new Dictionary<string, List<AppRun>>(StringComparer.Ordinal);
    static string InstanceKey(string scope, string id) => scope + "|" + id;
    static string ApplicationKey(string scope, ProcessIdentity process) => scope + "|" + process.Boot + "|" + process.Sid + "|" + (process.Path == null ? "instance:" + process.Id : process.Path.ToUpperInvariant());
    static bool Visible(string scope, ProcessIdentity process) => scope == "machine" || process.Sid != null && scope.Length==4+process.Sid.Length && scope.StartsWith("own:",StringComparison.Ordinal) && string.CompareOrdinal(scope,4,process.Sid,0,process.Sid.Length)==0;
    static DateTime Later(DateTime a, DateTime b) => a > b ? a : b;
    static DateTime Earlier(DateTime a, DateTime b) => a < b ? a : b;

    public RunTotals(string root, IEnumerable<ProcessIdentity> current, DateTime now) {
      writer = new SqliteConnection(new SqliteConnectionStringBuilder {DataSource=Path.Combine(root,"history.db"),Mode=SqliteOpenMode.ReadWriteCreate,Pooling=false,DefaultTimeout=5}.ToString());
      writer.Open();
      Execute(null,"PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;");
      Execute(null,@"CREATE TABLE IF NOT EXISTS run_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS run_app(run_id TEXT PRIMARY KEY,app_key TEXT NOT NULL,scope_id TEXT NOT NULL,started_ms INTEGER NOT NULL,observed_ms INTEGER NOT NULL,end_ms INTEGER,rx_bytes INTEGER NOT NULL CHECK(rx_bytes>=0),tx_bytes INTEGER NOT NULL CHECK(tx_bytes>=0),has_gap INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS run_instance(scope_id TEXT NOT NULL,instance_id TEXT NOT NULL,run_id TEXT NOT NULL,boot_id TEXT NOT NULL,pid INTEGER NOT NULL,created_filetime TEXT NOT NULL,owner_sid TEXT,image_path TEXT,name TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER,observed_ms INTEGER NOT NULL,rx_bytes INTEGER NOT NULL CHECK(rx_bytes>=0),tx_bytes INTEGER NOT NULL CHECK(tx_bytes>=0),PRIMARY KEY(scope_id,instance_id));");
      var version = Scalar("SELECT value FROM run_metadata WHERE key='version'");
      if (version != null && Convert.ToString(version) != "1") throw new InvalidDataException("incompatible-run-schema");
      Execute(null,"INSERT OR IGNORE INTO run_metadata VALUES('version','1')");
      Restore(current.Where(process=>process.End==DateTime.MaxValue).ToArray(),now);
    }
    object Scalar(string sql) {using(var command=writer.CreateCommand()){command.CommandText=sql;var value=command.ExecuteScalar();return value==DBNull.Value?null:value;}}
    void Execute(SqliteTransaction transaction,string sql,params object[] fields) {
      using(var command=writer.CreateCommand()) {command.Transaction=transaction;command.CommandTimeout=5;command.CommandText=sql;for(var index=0;index<fields.Length;index+=2)command.Parameters.AddWithValue((string)fields[index],fields[index+1]??DBNull.Value);command.ExecuteNonQuery();}
    }
    void Add(AppRun application) {
      applications.Add(application.Id,application);
      if(!byApplication.TryGetValue(application.Key,out var runs))byApplication[application.Key]=runs=new List<AppRun>();
      runs.Add(application);
    }
    void Add(Instance instance) {
      instances.Add(InstanceKey(instance.Scope,instance.Process.Id),instance);
      if(!byScope.TryGetValue(instance.Scope,out var scoped))byScope[instance.Scope]=scoped=new Dictionary<string,Instance>(StringComparer.Ordinal);
      scoped.Add(instance.Process.Id,instance);
    }
    void RemoveInstance(string key) {var instance=instances[key];instances.Remove(key);var scoped=byScope[instance.Scope];scoped.Remove(instance.Process.Id);if(scoped.Count==0)byScope.Remove(instance.Scope);}
    void Restore(ProcessIdentity[] current,DateTime now) {
      var checkpoint=Scalar("SELECT value FROM run_metadata WHERE key='checkpoint'");
      var at=checkpoint==null?now:Json.Time(Convert.ToInt64(checkpoint));
      using(var command=writer.CreateCommand()) {
        command.CommandText="SELECT run_id,app_key,scope_id,started_ms,observed_ms,end_ms,rx_bytes,tx_bytes,has_gap FROM run_app";
        using(var reader=command.ExecuteReader())while(reader.Read())Add(new AppRun {Id=reader.GetString(0),Key=reader.GetString(1),Scope=reader.GetString(2),Started=Json.Time(reader.GetInt64(3)),Observed=Json.Time(reader.GetInt64(4)),End=reader.IsDBNull(5)?DateTime.MaxValue:Json.Time(reader.GetInt64(5)),Rx=reader.GetInt64(6),Tx=reader.GetInt64(7),Gap=true});
      }
      var live=current.ToDictionary(process=>process.Id,StringComparer.Ordinal);
      using(var command=writer.CreateCommand()) {
        command.CommandText="SELECT scope_id,instance_id,run_id,boot_id,pid,created_filetime,owner_sid,image_path,name,start_ms,end_ms,observed_ms,rx_bytes,tx_bytes FROM run_instance";
        using(var reader=command.ExecuteReader())while(reader.Read()) {
          if(!applications.TryGetValue(reader.GetString(2),out var application))continue;
          var identity=new ProcessIdentity {Id=reader.GetString(1),Boot=reader.GetString(3),Pid=reader.GetInt32(4),Created=long.Parse(reader.GetString(5)),Sid=reader.IsDBNull(6)?null:reader.GetString(6),Path=reader.IsDBNull(7)?null:reader.GetString(7),Name=reader.GetString(8),Start=Json.Time(reader.GetInt64(9)),End=reader.IsDBNull(10)?at:Json.Time(reader.GetInt64(10))};
          if(live.TryGetValue(identity.Id,out var active))identity=active;
          var scope=reader.GetString(0);
          var instance=new Instance {Scope=scope,Process=identity,GroupedPath=identity.Path,GroupedSid=identity.Sid,GroupKey=ApplicationKey(scope,identity),App=application,Observed=Json.Time(reader.GetInt64(11)),Rx=reader.GetInt64(12),Tx=reader.GetInt64(13)};
          Add(instance);
        }
      }
      // A matching live generation proves continuity. A process already alive at
      // the checkpoint can also bridge a just-spawned member not yet catalogued.
      var keep=new HashSet<string>(instances.Values.Where(instance=>instance.Process.End==DateTime.MaxValue).Select(instance=>instance.App.Id));
      foreach(var application in applications.Values.Where(run=>run.End==DateTime.MaxValue))
        if(current.Any(process=>process.Start<=at&&ApplicationKey(application.Scope,process)==application.Key))keep.Add(application.Id);
      foreach(var key in instances.Where(pair=>!keep.Contains(pair.Value.App.Id)).Select(pair=>pair.Key).ToArray())RemoveInstance(key);
      foreach(var application in applications.Values.Where(run=>!keep.Contains(run.Id)).ToArray())Remove(application);
      CloseInactive(now);
    }
    void Remove(AppRun application) {
      applications.Remove(application.Id);
      var runs=byApplication[application.Key];runs.Remove(application);if(runs.Count==0)byApplication.Remove(application.Key);
    }
    void CloseInactive(DateTime now) {
      foreach(var group in instances.Values.GroupBy(instance=>instance.App.Id)) {
        var application=group.First().App;
        application.End=group.Any(instance=>instance.Process.End==DateTime.MaxValue)?DateTime.MaxValue:group.Max(instance=>Earlier(instance.Process.End,now));
      }
    }
    AppRun Application(string scope,ProcessIdentity process,DateTime observed,DateTime now) {
      CloseInactive(now);
      var key=ApplicationKey(scope,process);
      AppRun application=null;
      if(byApplication.TryGetValue(key,out var runs))application=runs.Where(run=>process.Start<run.End&&process.End>run.Started).OrderByDescending(run=>run.End==DateTime.MaxValue).ThenByDescending(run=>run.Started).FirstOrDefault();
      if(application==null) {
        application=new AppRun {Id=Guid.NewGuid().ToString("N"),Key=key,Scope=scope,Started=process.Start,Observed=Later(process.Start,observed),Gap=process.Start<observed,End=process.End};
        Add(application);
      }
      application.Started=Earlier(application.Started,process.Start);
      application.Observed=Earlier(application.Observed,Later(process.Start,observed));
      application.Gap|=process.Start<observed;
      application.End=application.End==DateTime.MaxValue||process.End==DateTime.MaxValue?DateTime.MaxValue:Later(application.End,process.End);
      return application;
    }
    Instance Ensure(string scope,ProcessIdentity process,DateTime observed,DateTime now) {
      if(!Visible(scope,process))throw new UnauthorizedAccessException("run-process-not-visible");
      if(byScope.TryGetValue(scope,out var scoped)&&scoped.TryGetValue(process.Id,out var instance)) {
        instance.Process=process;
        // Packet-rate updates reuse identity keys. Normalize a potentially long
        // executable path only when the catalog actually fills its metadata.
        if(instance.GroupedPath!=process.Path||instance.GroupedSid!=process.Sid) {
          instance.GroupedPath=process.Path;instance.GroupedSid=process.Sid;instance.GroupKey=ApplicationKey(scope,process);
        }
        if(instance.App.Key!=instance.GroupKey) {
          var previous=instance.App;var target=Application(scope,process,instance.Observed,now);
          var previousRx=checked(previous.Rx-instance.Rx);var previousTx=checked(previous.Tx-instance.Tx);
          var targetRx=checked(target.Rx+instance.Rx);var targetTx=checked(target.Tx+instance.Tx);
          previous.Rx=previousRx;previous.Tx=previousTx;target.Rx=targetRx;target.Tx=targetTx;target.Gap|=previous.Gap;
          instance.App=target;
          if(!instances.Values.Any(value=>value.App==previous))previous.End=now;
        }
        return instance;
      }
      var application=Application(scope,process,observed,now);
      var created=new Instance {Scope=scope,Process=process,GroupedPath=process.Path,GroupedSid=process.Sid,GroupKey=application.Key,Observed=Later(process.Start,observed),App=application};
      Add(created);
      return created;
    }
    public void Reconcile(string scope,IEnumerable<ProcessIdentity> processes,DateTime observed,bool collecting,DateTime now) {
      var known=processes.Where(process=>Visible(scope,process)).ToDictionary(process=>process.Id,StringComparer.Ordinal);
      foreach(var instance in instances.Values.Where(value=>value.Scope==scope)) {
        if(known.TryGetValue(instance.Process.Id,out var current))instance.Process=current;
        else if(instance.Process.End==DateTime.MaxValue)instance.Process.End=now;
      }
      CloseInactive(now);
      if(collecting)foreach(var process in known.Values.Where(process=>process.End==DateTime.MaxValue))Ensure(scope,process,observed,now);
      else MarkGap(scope);
      foreach(var key in instances.Where(pair=>pair.Value.Process.End<now.AddMinutes(-5)).Select(pair=>pair.Key).ToArray())RemoveInstance(key);
      foreach(var application in applications.Values.Where(run=>run.End<now.AddMinutes(-5)).ToArray())Remove(application);
    }
    public void MarkGap(string scope) {foreach(var application in applications.Values.Where(run=>run.Scope==scope&&run.End==DateTime.MaxValue))application.Gap=true;}
    public void Observe(string scope,ProcessIdentity process,bool receive,long bytes,DateTime at,DateTime observed,DateTime now) {
      if(bytes<0)throw new InvalidDataException("invalid-run-observation");
      var instance=Ensure(scope,process,Earlier(observed,at),now);
      if(receive){var value=checked(instance.Rx+bytes);var total=checked(instance.App.Rx+bytes);instance.Rx=value;instance.App.Rx=total;}
      else {var value=checked(instance.Tx+bytes);var total=checked(instance.App.Tx+bytes);instance.Tx=value;instance.App.Tx=total;}
    }
    public Dictionary<string,object> Describe(string scope,ProcessIdentity process,DateTime observed,DateTime now) {
      var instance=Ensure(scope,process,observed,now);var application=instance.App;
      return Json.Obj("alive",process.End==DateTime.MaxValue,"runRxBytes",Json.Decimal(instance.Rx),"runTxBytes",Json.Decimal(instance.Tx),"observedSince",Json.Iso(instance.Observed),"appRunId",application.Id,"appRunRxBytes",Json.Decimal(application.Rx),"appRunTxBytes",Json.Decimal(application.Tx),"appRunStartedAt",Json.Iso(application.Started),"appRunObservedSince",Json.Iso(application.Observed),"appRunCoverage",application.Gap?"gap":"complete");
    }
    public void Checkpoint(DateTime now) {
      using(var transaction=writer.BeginTransaction()) {
        Execute(transaction,"DELETE FROM run_instance;DELETE FROM run_app;");
        foreach(var run in applications.Values)Execute(transaction,"INSERT INTO run_app VALUES($id,$key,$scope,$start,$observed,$end,$rx,$tx,$gap)","$id",run.Id,"$key",run.Key,"$scope",run.Scope,"$start",Json.Unix(run.Started),"$observed",Json.Unix(run.Observed),"$end",run.End==DateTime.MaxValue?null:(object)Json.Unix(run.End),"$rx",run.Rx,"$tx",run.Tx,"$gap",run.Gap?1:0);
        foreach(var instance in instances.Values) {
          var process=instance.Process;
          Execute(transaction,"INSERT INTO run_instance VALUES($scope,$id,$run,$boot,$pid,$created,$sid,$path,$name,$start,$end,$observed,$rx,$tx)","$scope",instance.Scope,"$id",process.Id,"$run",instance.App.Id,"$boot",process.Boot,"$pid",process.Pid,"$created",Json.Decimal(process.Created),"$sid",process.Sid,"$path",process.Path,"$name",process.Name,"$start",Json.Unix(process.Start),"$end",process.End==DateTime.MaxValue?null:(object)Json.Unix(process.End),"$observed",Json.Unix(instance.Observed),"$rx",instance.Rx,"$tx",instance.Tx);
        }
        Execute(transaction,"INSERT INTO run_metadata VALUES('checkpoint',$time) ON CONFLICT(key) DO UPDATE SET value=excluded.value","$time",Json.Decimal(Json.Unix(now)));
        transaction.Commit();
      }
    }
    public void Dispose() => writer.Dispose();
  }
}
