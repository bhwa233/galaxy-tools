using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Session;

namespace Spark.Traffic {
  public sealed class TrafficEvent {
    public int Pid, EventId;
    public long Bytes;
    public bool Receive, IPv6, Udp;
    public DateTime Timestamp;
    public byte[] Payload;
  }
  public sealed class NetworkEventSource : IDisposable {
    public static readonly Guid Provider = new Guid("7dd42a49-5329-4832-8dfd-43d979153a88");
    static readonly Guid ProcessProvider = new Guid("22fb2cd6-0e7b-422b-a0c7-2fad1fd0e716");
    readonly ConcurrentQueue<TrafficEvent> queue = new ConcurrentQueue<TrafficEvent>();
    TraceEventSession session;
    Thread thread;
    int queued;
    long dropped, parseErrors;
    long eventsLost, buffersLost;
    public string Error { get; private set; }
    public bool Running => session != null && Error == null;
    public long QueueDropped => Interlocked.Read(ref dropped);
    public long ParseErrors => Interlocked.Read(ref parseErrors);
    public long EventsLost => Interlocked.Read(ref eventsLost);
    public long RealtimeBuffersLost => Interlocked.Read(ref buffersLost);
    [StructLayout(LayoutKind.Sequential)] struct Wnode {public uint BufferSize,ProviderId;public ulong HistoricalContext;public long Timestamp;public Guid Guid;public uint ClientContext,Flags;}
    [StructLayout(LayoutKind.Sequential)] struct Properties {public Wnode Wnode;public uint BufferSize,MinimumBuffers,MaximumBuffers,MaximumFileSize,LogFileMode,FlushTimer,EnableFlags;public int AgeLimit;public uint NumberOfBuffers,FreeBuffers,EventsLost,BuffersWritten,LogBuffersLost,RealTimeBuffersLost;public IntPtr LoggerThreadId;public uint LogFileNameOffset,LoggerNameOffset;}
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint ControlTrace(ulong handle,string name,IntPtr properties,uint control);
    public void RefreshQuality() {
      var owned=session;if(owned==null)return;var buffer=Marshal.AllocHGlobal(8192);
      try {
        var properties=new Properties {Wnode=new Wnode {BufferSize=8192},LoggerNameOffset=(uint)Marshal.SizeOf<Properties>(),LogFileNameOffset=(uint)Marshal.SizeOf<Properties>()+2048};
        Marshal.StructureToPtr(properties,buffer,false);
        if(ControlTrace(0,owned.SessionName,buffer,0)==0){properties=Marshal.PtrToStructure<Properties>(buffer);Interlocked.Exchange(ref eventsLost,properties.EventsLost);Interlocked.Exchange(ref buffersLost,properties.RealTimeBuffersLost);}
      }finally{Marshal.FreeHGlobal(buffer);}
    }
    public void Start() {
      if (session != null) return;
      Error = null;
      try {
        // Never attach to or restart a global kernel logger. The manifest provider works in a private, uniquely named regular session.
        session = new TraceEventSession("spark233-traffic-" + Process.GetCurrentProcess().Id + "-" + Guid.NewGuid().ToString("N"), TraceEventSessionOptions.Create | TraceEventSessionOptions.NoRestartOnCreate) { StopOnDispose = true, BufferSizeMB = 16 };
        session.Source.AllEvents += OnEvent;
        session.EnableProvider(Provider, TraceEventLevel.Informational, 0x30);
        session.EnableProvider(ProcessProvider, TraceEventLevel.Informational, 0x10);
        var ownedSession = session;
        thread = new Thread(() => { try { ownedSession.Source.Process(); } catch (Exception ex) { Error = ex.GetType().Name; } }) { IsBackground = true, Name = "Traffic ETW consumer" };
        thread.Start();
      } catch (Exception ex) { Error = "etw-unavailable:" + ex.GetType().Name; session?.Dispose(); session = null; }
    }
    void OnEvent(TraceEvent ev) {
      if (ev.ProviderGuid == ProcessProvider && ((int)ev.ID == 1 || (int)ev.ID == 2)) {
        var data = new byte[Math.Min(ev.EventDataLength,12)];ev.EventData(data,0,0,data.Length);
        if (data.Length >= 12) Enqueue(new TrafficEvent { EventId = (int)ev.ID, Timestamp = ev.TimeStamp.ToUniversalTime(), Pid = BitConverter.ToInt32(data, 0), Payload = data });
        return;
      }
      if (ev.ProviderGuid != Provider) return;
      var id = (int)ev.ID;
      var receive = id == 11 || id == 27 || id == 43 || id == 59;
      if (!receive && id != 10 && id != 26 && id != 42 && id != 58) return;
      // TraceEvent's classic TcpIp parser has different provider/opcode semantics. This manifest-only adapter uses the verified v0 Windows schema (PID,size,daddr,saddr,dport,sport); other versions fail closed.
      var ipv6 = id == 26 || id == 27 || id == 58 || id == 59;
      if (ev.Version != 0 || ev.EventDataLength < (ipv6 ? 44 : 20)) { Interlocked.Increment(ref parseErrors); return; }
      var payload = ev.EventData();
      Enqueue(new TrafficEvent { EventId = id, Pid = BitConverter.ToInt32(payload, 0), Bytes = BitConverter.ToUInt32(payload, 4), Receive = receive, IPv6 = ipv6, Udp = id >= 42, Timestamp = ev.TimeStamp.ToUniversalTime(), Payload = payload });
    }
    void Enqueue(TrafficEvent value) {
      if (Interlocked.Increment(ref queued) > 131072) { Interlocked.Decrement(ref queued); Interlocked.Increment(ref dropped); return; }
      queue.Enqueue(value);
    }
    public bool TryRead(out TrafficEvent value) {
      if (!queue.TryDequeue(out value)) return false;
      Interlocked.Decrement(ref queued); return true;
    }
    public void Stop() {
      RefreshQuality();
      var owned = session; session = null;
      owned?.Dispose();
      if (thread != null && thread != Thread.CurrentThread) thread.Join(3000);
      thread = null;
    }
    public void ResetFailure() {if(Error!=null){Stop();Error=null;}}
    public void Dispose() => Stop();
  }
}
