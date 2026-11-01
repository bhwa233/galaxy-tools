using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Microsoft.Data.Sqlite;

namespace Spark.Traffic {
  public sealed class BucketDelta {
    public string Scope;
    public int Resolution;
    public long Start, Rx, Tx;
    public ProcessIdentity Process;
  }
  public sealed class Coverage {
    public string Scope, Epoch, State, Reason;
    public long Start, End;
    public Dictionary<string, object> Describe() => Json.Obj("start", Json.Iso(Json.Time(Start)), "end", Json.Iso(Json.Time(End)), "state", State, "reason", Reason);
  }
  public sealed class HistoryStore : IDisposable {
    readonly SqliteConnection writer;
    readonly string connectionString;
    public long DurableThrough { get; private set; }
    public HistoryStore(string root) {
      Directory.CreateDirectory(root);
      connectionString = new SqliteConnectionStringBuilder { DataSource = Path.Combine(root, "history.db"), Mode = SqliteOpenMode.ReadWriteCreate, Pooling = false, DefaultTimeout = 5 }.ToString();
      writer = new SqliteConnection(connectionString); writer.Open();
      Execute(writer, null, "PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;");
      var version = Convert.ToInt32(Scalar(writer, "PRAGMA user_version;"));
      if (version > 1) throw new InvalidDataException("incompatible-history-schema");
      if (version == 0) {
        using (var tx = writer.BeginTransaction()) {
          Execute(writer, tx, @"CREATE TABLE process_instance(instance_id TEXT PRIMARY KEY,boot_id TEXT NOT NULL,pid INTEGER NOT NULL,created_filetime TEXT,owner_sid TEXT,image_path TEXT,name TEXT NOT NULL,identity_state TEXT NOT NULL);
CREATE TABLE traffic_bucket(scope_id TEXT NOT NULL,resolution_sec INTEGER NOT NULL,bucket_start_utc INTEGER NOT NULL,instance_id TEXT NOT NULL REFERENCES process_instance(instance_id),rx_bytes INTEGER NOT NULL CHECK(typeof(rx_bytes)='integer' AND rx_bytes>=0),tx_bytes INTEGER NOT NULL CHECK(typeof(tx_bytes)='integer' AND tx_bytes>=0),PRIMARY KEY(scope_id,resolution_sec,bucket_start_utc,instance_id));
CREATE INDEX traffic_instance_reference ON traffic_bucket(instance_id);
CREATE TABLE coverage_interval(scope_id TEXT NOT NULL,collector_epoch TEXT NOT NULL,start_utc_ms INTEGER NOT NULL,end_utc_ms INTEGER NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(scope_id,collector_epoch,start_utc_ms));
CREATE TABLE commit_batch(batch_id TEXT PRIMARY KEY,durable_utc_ms INTEGER NOT NULL);
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
PRAGMA user_version=1;"); tx.Commit();
        }
      }
      var durable = Scalar(writer, "SELECT value FROM metadata WHERE key='durable';");
      DurableThrough = durable == null ? 0 : long.Parse((string)durable);
    }
    static object Scalar(SqliteConnection connection, string sql,SqliteTransaction tx=null) { using (var cmd = connection.CreateCommand()) {cmd.Transaction=tx;cmd.CommandText = sql; var result = cmd.ExecuteScalar(); return result == DBNull.Value ? null : result; } }
    static int Execute(SqliteConnection connection, SqliteTransaction tx, string sql, params object[] fields) {
      using (var cmd = connection.CreateCommand()) { cmd.Transaction = tx; cmd.CommandTimeout = 5; cmd.CommandText = sql; for (var i = 0; i < fields.Length; i += 2) cmd.Parameters.AddWithValue((string)fields[i], fields[i + 1] ?? DBNull.Value); return cmd.ExecuteNonQuery(); }
    }
    public void Commit(string batchId, IEnumerable<BucketDelta> deltas, IEnumerable<Coverage> coverage, long durable) {
      using (var tx = writer.BeginTransaction()) {
        if (Execute(writer, tx, "INSERT OR IGNORE INTO commit_batch VALUES($id,$time)", "$id", batchId, "$time", durable) != 0) {
          foreach (var p in deltas.Select(d => d.Process).GroupBy(p => p.Id).Select(g => g.First())) {
            Execute(writer, tx, "INSERT INTO process_instance VALUES($id,$boot,$pid,$created,$sid,$path,$name,$state) ON CONFLICT(instance_id) DO UPDATE SET owner_sid=COALESCE(excluded.owner_sid,owner_sid),image_path=COALESCE(excluded.image_path,image_path),identity_state=excluded.identity_state", "$id", p.Id, "$boot", p.Boot, "$pid", p.Pid, "$created", Json.Decimal(p.Created), "$sid", p.Sid, "$path", p.Path, "$name", p.Name, "$state", p.State);
          }
          foreach (var d in deltas) Execute(writer, tx, "INSERT INTO traffic_bucket VALUES($scope,$res,$start,$id,$rx,$tx) ON CONFLICT(scope_id,resolution_sec,bucket_start_utc,instance_id) DO UPDATE SET rx_bytes=traffic_bucket.rx_bytes+excluded.rx_bytes,tx_bytes=traffic_bucket.tx_bytes+excluded.tx_bytes", "$scope", d.Scope, "$res", d.Resolution, "$start", d.Start, "$id", d.Process.Id, "$rx", d.Rx, "$tx", d.Tx);
          foreach (var c in coverage) Execute(writer, tx, "INSERT INTO coverage_interval VALUES($scope,$epoch,$start,$end,$state,$reason) ON CONFLICT(scope_id,collector_epoch,start_utc_ms) DO UPDATE SET end_utc_ms=excluded.end_utc_ms,state=excluded.state,reason=excluded.reason", "$scope", c.Scope, "$epoch", c.Epoch, "$start", c.Start, "$end", c.End, "$state", c.State, "$reason", c.Reason);
          Execute(writer, tx, "INSERT INTO metadata VALUES('durable',$time) ON CONFLICT(key) DO UPDATE SET value=excluded.value", "$time", Json.Decimal(durable));
        }
        tx.Commit(); DurableThrough = durable;
      }
    }
    public void Retain(DateTime now) {
      using (var tx = writer.BeginTransaction()) {
        foreach (var retention in new[] { new[] {60, 2}, new[] {3600, 90}, new[] {86400, 730} }) {
          Execute(writer, tx, "DELETE FROM traffic_bucket WHERE rowid IN (SELECT rowid FROM traffic_bucket WHERE resolution_sec=$res AND bucket_start_utc<$cut LIMIT 5000)", "$res", retention[0], "$cut", Json.Unix(now.AddDays(-retention[1])) / 1000);
        }
        Execute(writer, tx, "DELETE FROM coverage_interval WHERE end_utc_ms<$cut; DELETE FROM commit_batch WHERE durable_utc_ms<$cut", "$cut", Json.Unix(now.AddDays(-730)));
        Execute(writer, tx, "DELETE FROM process_instance WHERE rowid IN (SELECT p.rowid FROM process_instance p WHERE NOT EXISTS(SELECT 1 FROM traffic_bucket b WHERE b.instance_id=p.instance_id) LIMIT 1000)");
        tx.Commit();
      }
      Execute(writer, null, "PRAGMA wal_checkpoint(PASSIVE);");
    }
    public Dictionary<string, object> Query(string scope, Dictionary<string, object> request) {
      var to = Json.Date(request, "to", DateTime.UtcNow); var from = Json.Date(request, "from", to.AddHours(-1));
      if (from >= to || from < to.AddDays(-731) || to > DateTime.UtcNow.AddMinutes(1)) throw new InvalidDataException("invalid-history-range");
      var minimumResolution=from<DateTime.UtcNow.AddDays(-90)?86400:from<DateTime.UtcNow.AddHours(-48)?3600:60;
      var resolution = Math.Max(minimumResolution,Json.Int(request, "resolutionSec", minimumResolution, 60, 86400));
      if (resolution != 60 && resolution != 3600 && resolution != 86400) throw new InvalidDataException("invalid-resolution");
      const int limit = 100000; const int offset = 0;
      var groupPath = Json.Str(request, "groupBy") == "path";
      var rows = new List<object>();
      using (var readerConnection = new SqliteConnection(connectionString)) {
        readerConnection.Open();
        using(var transaction=readerConnection.BeginTransaction(true)) {
        using (var cmd = readerConnection.CreateCommand()) {
          cmd.Transaction=transaction;
          cmd.CommandTimeout = 5;
          // Stable key order; the service cursor layer pins query, caller and snapshot before exposing pagination.
          cmd.CommandText = groupPath
            ? "SELECT b.bucket_start_utc,p.instance_id,p.pid,p.name,p.image_path,SUM(b.rx_bytes),SUM(b.tx_bytes) FROM traffic_bucket b JOIN process_instance p ON p.instance_id=b.instance_id WHERE b.scope_id=$scope AND b.resolution_sec=$res AND b.bucket_start_utc >= $from AND b.bucket_start_utc < $to AND ($id='' OR b.instance_id=$id) GROUP BY b.bucket_start_utc,COALESCE(p.image_path,p.instance_id) ORDER BY b.bucket_start_utc,COALESCE(p.image_path,p.instance_id) LIMIT $limit OFFSET $offset"
            : "SELECT b.bucket_start_utc,p.instance_id,p.pid,p.name,p.image_path,b.rx_bytes,b.tx_bytes FROM traffic_bucket b JOIN process_instance p ON p.instance_id=b.instance_id WHERE b.scope_id=$scope AND b.resolution_sec=$res AND b.bucket_start_utc >= $from AND b.bucket_start_utc < $to AND ($id='' OR b.instance_id=$id) ORDER BY b.bucket_start_utc,p.instance_id LIMIT $limit OFFSET $offset";
          cmd.Parameters.AddWithValue("$scope", scope); cmd.Parameters.AddWithValue("$res", resolution); cmd.Parameters.AddWithValue("$from", Json.Unix(from) / 1000); cmd.Parameters.AddWithValue("$to", Json.Unix(to) / 1000); cmd.Parameters.AddWithValue("$id", Json.Str(request,"processInstanceId")); cmd.Parameters.AddWithValue("$limit", limit + 1); cmd.Parameters.AddWithValue("$offset", offset);
          var budget=Stopwatch.StartNew();
          using (var reader = cmd.ExecuteReader()) while (reader.Read()) {if(budget.ElapsedMilliseconds>5000||rows.Count>=limit)throw new InvalidOperationException("history-query-too-large-narrow-range");rows.Add(Json.Obj("bucketStart", Json.Iso(Json.Time(reader.GetInt64(0) * 1000)), "resolutionSec", resolution, "processInstanceId", reader.GetString(1), "pid", reader.GetInt32(2), "name", reader.GetString(3), "imagePath", reader.IsDBNull(4) ? null : reader.GetString(4), "rxBytes", Json.Decimal(reader.GetInt64(5)), "txBytes", Json.Decimal(reader.GetInt64(6))));}
        }
        var earliest = ScalarWithScope(readerConnection, "SELECT MIN(bucket_start_utc) FROM traffic_bucket WHERE scope_id=$scope AND resolution_sec=" + resolution, scope,transaction);
        var durable=Scalar(readerConnection,"SELECT value FROM metadata WHERE key='durable'",transaction);
        var start=Json.Unix(from);
        var end=Math.Max(start,Math.Min(Json.Unix(to),durable==null?start:Convert.ToInt64(durable)));
        return Json.Obj("source", "etw", "rows", rows, "coverageSummary", SummarizeCoverage(readerConnection,transaction,scope,start,end), "durableThrough", durable==null ? null : Json.Iso(Json.Time(Convert.ToInt64(durable))), "earliestAvailable", earliest == null ? null : Json.Iso(Json.Time(Convert.ToInt64(earliest) * 1000)), "resolutionSec", resolution, "nextCursor", null);
        }
      }
    }
    static Dictionary<string,object> SummarizeCoverage(SqliteConnection connection,SqliteTransaction transaction,string scope,long from,long to) {
      long covered=0;
      if(to>from) {
        using(var cmd=connection.CreateCommand()) {
          cmd.Transaction=transaction;cmd.CommandTimeout=5;
          // Reuse SQLite window functions to sweep every interval once. Returning
          // raw intervals made the shared page metadata exceed the pipe budget;
          // truncating them also invented gaps after the first 1,000 records.
          cmd.CommandText=@"WITH clipped AS (
SELECT MAX(start_utc_ms,$from) AS start,MIN(end_utc_ms,$to) AS stop,CASE WHEN state='covered' THEN 1 ELSE 0 END AS good
FROM coverage_interval WHERE scope_id=$scope AND end_utc_ms>$from AND start_utc_ms<$to
), events AS (
SELECT start AS at,good AS covered_delta,1-good AS gap_delta FROM clipped WHERE stop>start
UNION ALL SELECT stop,-good,good-1 FROM clipped WHERE stop>start
UNION ALL SELECT $from,0,0 UNION ALL SELECT $to,0,0
), points AS (
SELECT at,SUM(covered_delta) AS covered_delta,SUM(gap_delta) AS gap_delta FROM events GROUP BY at
), spans AS (
SELECT at,LEAD(at) OVER(ORDER BY at) AS stop,
SUM(covered_delta) OVER(ORDER BY at ROWS UNBOUNDED PRECEDING) AS active_covered,
SUM(gap_delta) OVER(ORDER BY at ROWS UNBOUNDED PRECEDING) AS active_gap FROM points
)
SELECT COALESCE(SUM(CASE WHEN stop>at AND active_covered>0 AND active_gap=0 THEN stop-at ELSE 0 END),0) FROM spans";
          cmd.Parameters.AddWithValue("$scope",scope);cmd.Parameters.AddWithValue("$from",from);cmd.Parameters.AddWithValue("$to",to);
          covered=Convert.ToInt64(cmd.ExecuteScalar());
        }
      }
      var gap=to-from-covered;
      return Json.Obj("state",covered==0?"unavailable":gap==0?"complete":"gap","start",Json.Iso(Json.Time(from)),"end",Json.Iso(Json.Time(to)),"coveredMs",Json.Decimal(covered),"gapMs",Json.Decimal(gap));
    }
    static object ScalarWithScope(SqliteConnection db, string sql, string scope,SqliteTransaction tx=null) { using (var cmd = db.CreateCommand()) {cmd.Transaction=tx;cmd.CommandText = sql; cmd.Parameters.AddWithValue("$scope",scope); var value=cmd.ExecuteScalar(); return value==DBNull.Value?null:value; } }
    public void Clear(string scope) {
      using (var tx = writer.BeginTransaction()) { Execute(writer, tx, "DELETE FROM traffic_bucket WHERE scope_id=$scope; DELETE FROM coverage_interval WHERE scope_id=$scope;", "$scope", scope); tx.Commit(); }
    }
    public void Dispose() { Execute(writer, null, "PRAGMA wal_checkpoint(TRUNCATE);"); writer.Dispose(); }
  }
}
