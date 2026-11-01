using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace Spark.Traffic {
  public sealed class ProcessIdentity {
    public string Id, Sid, Path, Name, Boot;
    public int Pid;
    public long Created;
    public DateTime Start, End = DateTime.MaxValue;
    public string State => Sid == null ? "unresolved-owner" : "verified";
    public Dictionary<string, object> Describe() => Json.Obj("processInstanceId", Id, "pid", Pid, "name", Name, "imagePath", Path, "createdFileTime", Json.Decimal(Created), "identityState", State);
  }
  public sealed class ProcessCatalog {
    readonly Dictionary<int, List<ProcessIdentity>> entries = new Dictionary<int, List<ProcessIdentity>>();
    readonly string boot;
    public ProcessCatalog() {
      // SystemBootEnvironmentInformation exposes the stable boot GUID; it is independent of wall clock adjustments.
      var pointer = Marshal.AllocHGlobal(64);
      try {
        if (Native.NtQuerySystemInformation(90, pointer, 64, out _) != 0) throw new InvalidOperationException("boot-identity-unavailable");
        boot = Marshal.PtrToStructure<Guid>(pointer).ToString("N");
      } finally { Marshal.FreeHGlobal(pointer); }
      Refresh();
    }
    public void Refresh() {
      var alive = new HashSet<int>();
      foreach (var process in Process.GetProcesses()) {
        using (process) {
          var pid = process.Id; alive.Add(pid);
          var identity = Native.ReadProcess(pid, boot);
          if (identity == null) continue;
          if (!entries.TryGetValue(pid, out var versions)) entries[pid] = versions = new List<ProcessIdentity>();
          var old = versions.OrderBy(p=>p.Created).LastOrDefault();
          if (old != null && old.Created == identity.Created) {
            if (old.Sid == null) old.Sid = identity.Sid;
            if (old.Path == null) old.Path = identity.Path;
            continue;
          }
          Insert(versions,identity);
        }
      }
      var now = DateTime.UtcNow;
      foreach (var pair in entries.ToArray()) {
        foreach (var version in pair.Value) if (!alive.Contains(pair.Key) && version.End == DateTime.MaxValue) version.End = now;
        pair.Value.RemoveAll(version => version.End < now.AddMinutes(-5));
        if (pair.Value.Count == 0) entries.Remove(pair.Key);
      }
    }
    public ProcessIdentity Resolve(int pid, DateTime timestamp) {
      if (!entries.TryGetValue(pid, out var versions)) {
        var current = Native.ReadProcess(pid, boot);
        if (current == null) return null;
        entries[pid] = versions = new List<ProcessIdentity> { current };
      }
      return versions.Where(p => p.Start <= timestamp && timestamp < p.End).OrderBy(p=>p.Created).LastOrDefault();
    }
    public ProcessIdentity Find(string id) => entries.Values.SelectMany(v => v).FirstOrDefault(p => p.Id == id);
    public void Observe(TrafficEvent value) {
      var created = BitConverter.ToInt64(value.Payload, 4);
      if (created <= 0) return;
      if (!entries.TryGetValue(value.Pid, out var versions)) entries[value.Pid] = versions = new List<ProcessIdentity>();
      var existing = versions.FirstOrDefault(p => p.Created == created);
      if (existing == null) {
        var live = Native.ReadProcess(value.Pid, boot);
        existing = live != null && live.Created == created ? live : new ProcessIdentity { Id = boot + ":" + value.Pid + ":" + created, Boot = boot, Pid = value.Pid, Created = created, Start = DateTime.FromFileTimeUtc(created), Name = "Process " + value.Pid };
        Insert(versions,existing);
      }
      if (value.EventId == 2) existing.End = value.Timestamp;
    }
    static void Insert(List<ProcessIdentity> versions,ProcessIdentity identity) {
      versions.Add(identity);versions.Sort((a,b)=>a.Created.CompareTo(b.Created));
      for(var index=0;index+1<versions.Count;index++)if(versions[index].End>versions[index+1].Start)versions[index].End=versions[index+1].Start;
    }
    public IEnumerable<ProcessIdentity> All => entries.Values.SelectMany(v => v);
    public static ProcessIdentity Inspect(int pid) => Native.ReadProcess(pid,"inspect");
  }
  internal static partial class Native {
    [DllImport("ntdll.dll")] internal static extern int NtQuerySystemInformation(int informationClass, IntPtr buffer, int length, out int returned);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int length);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    internal static ProcessIdentity ReadProcess(int pid, string boot) {
      var process = OpenProcess(0x1000, false, pid); if (process == IntPtr.Zero) return null;
      try {
        if (!GetProcessTimes(process, out var created, out _, out _, out _)) return null;
        var path = new StringBuilder(32768); var length = path.Capacity;
        var image = QueryFullProcessImageName(process, 0, path, ref length) ? path.ToString() : null;
        string sid = null;
        if (OpenProcessToken(process, 8, out var token)) {
          try { using (var identity = new WindowsIdentity(token)) sid = identity.User?.Value; } finally { CloseHandle(token); }
        }
        return new ProcessIdentity { Id = boot + ":" + pid + ":" + created, Boot = boot, Pid = pid, Created = created, Start = DateTime.FromFileTimeUtc(created), Sid = sid, Path = image, Name = image == null ? "Process " + pid : System.IO.Path.GetFileName(image) };
      } finally { CloseHandle(process); }
    }
  }
}
