using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Spark.Traffic {
  public sealed class PipeServer : IDisposable {
    sealed class Page {
      public string Sid,Fingerprint,Field;
      public DateTime Expires;
      public Dictionary<string,object> Value;
      public object[] Rows;
      public int Offset;
    }
    readonly TrafficEngine engine;
    readonly string name;
    readonly Dictionary<string,Page> pages=new Dictionary<string,Page>();
    readonly List<NamedPipeServerStream> connected=new List<NamedPipeServerStream>();
    readonly object sync=new object();
    readonly SemaphoreSlim slots=new SemaphoreSlim(16);
    Thread listener;
    bool disposed;
    NamedPipeServerStream pending;
    public PipeServer(TrafficEngine engine,string name) {this.engine=engine;this.name=name;listener=new Thread(Listen){IsBackground=true,Name="Traffic pipe accept"};listener.Start();}
    void Listen() {
      var first=true;
      while(!disposed) {
        try {
          slots.Wait();if(disposed){slots.Release();return;}
          var pipe=CreatePipe(name,engine.GrantedSids,first);first=false;pending=pipe;
          pipe.WaitForConnection();pending=null;
          lock(sync)connected.Add(pipe);
          ThreadPool.QueueUserWorkItem(_=>Serve(pipe));
        }catch(Exception ex)when(ex is IOException||ex is ObjectDisposedException||ex is Win32Exception){if(!disposed)Console.Error.WriteLine("traffic-pipe-listener:"+ex.GetType().Name);slots.Release();}
      }
    }
    void Serve(NamedPipeServerStream pipe) {
      var connection=Guid.NewGuid().ToString("N");
      try {
        using(pipe)using(var reader=new StreamReader(pipe,new UTF8Encoding(false,true),false,4096,true))using(var writer=new StreamWriter(pipe,new UTF8Encoding(false),4096,true){AutoFlush=true,NewLine="\n"}) {
          string sid=null;
          // RunAsClient takes identity from the authenticated pipe token; all subsequent work runs as the service.
          pipe.RunAsClient(()=>{using(var identity=WindowsIdentity.GetCurrent(true)){sid=identity?.User?.Value;}});
          if(sid==null||!engine.GrantedSids.Contains(sid))throw new UnauthorizedAccessException("caller-not-granted");
          for(;;) {
            var line=Json.ReadLine(reader,65536);if(line==null)break;
            string requestId="";
            try {
              var request=Json.Decode(line);requestId=Json.Str(request,"id");
              if(Json.Int(request,"v",0,0,1)!=1||requestId.Length==0||requestId.Length>100)throw new InvalidDataException("invalid-protocol");
              var data=Dispatch(sid,connection,request);
              var message=Json.Encode(Json.Obj("v",1,"id",requestId,"ok",true,"data",data));
              if(Encoding.UTF8.GetByteCount(message)>65536)throw new InvalidOperationException("response-too-large");
              writer.WriteLine(message);
            }catch(Exception ex) {writer.WriteLine(Json.Encode(Json.Obj("v",1,"id",requestId,"ok",false,"error",Error(ex))));}
          }
        }
      }catch(Exception ex)when(ex is IOException||ex is ObjectDisposedException||ex is UnauthorizedAccessException||ex is InvalidDataException||ex is DecoderFallbackException){}
      finally {try{engine.Release(connection);}catch(Exception ex){Console.Error.WriteLine("traffic-release:"+ex.GetType().Name);}lock(sync)connected.Remove(pipe);slots.Release();}
    }
    static string Error(Exception ex) => ex is InvalidOperationException||ex is InvalidDataException||ex is UnauthorizedAccessException?ex.Message.Substring(0,Math.Min(256,ex.Message.Length)):"service-error:"+ex.GetType().Name;
    object Dispatch(string sid,string connection,Dictionary<string,object> request) {
      var op=Json.Str(request,"op");
      if(op!="snapshot"&&op!="history"&&op!="connections"&&op!="icons")return engine.Handle(sid,connection,request);
      // Recheck token scope on every page. Opaque cursors bind caller, complete query and short expiry.
      engine.Handle(sid,connection,Json.Obj("op","status","scope",Json.Str(request,"scope","own")));
      var query=new Dictionary<string,object>(request);query.Remove("id");query.Remove("cursor");
      var fingerprint=Json.Encode(query.OrderBy(p=>p.Key).ToDictionary(p=>p.Key,p=>p.Value));
      var token=Json.Str(request,"cursor");Page page;
      lock(sync) {
        foreach(var key in pages.Where(p=>p.Value.Expires<DateTime.UtcNow).Select(p=>p.Key).ToArray())pages.Remove(key);
        if(token.Length>0) {
          if(!pages.TryGetValue(token,out page)||page.Sid!=sid||page.Fingerprint!=fingerprint)throw new InvalidOperationException("cursor-expired");
          pages.Remove(token);
        } else page=null;
      }
      if(page==null) {
        var value=(Dictionary<string,object>)engine.Handle(sid,connection,request);
        var field=op=="snapshot"?"processes":op=="history"?"rows":op=="connections"?"endpoints":"icons";
        var rows=value.TryGetValue(field,out var raw)&&raw is IEnumerable list?list.Cast<object>().ToArray():new object[0];
        page=new Page {Sid=sid,Fingerprint=fingerprint,Field=field,Value=value,Rows=rows,Expires=DateTime.UtcNow.AddSeconds(30)};
      }
      var limit=Json.Int(request,"limit",100,1,200);var selected=new List<object>();var bytes=Encoding.UTF8.GetByteCount(Json.Encode(page.Value.Where(p=>p.Key!=page.Field).ToDictionary(p=>p.Key,p=>p.Value)))+256;
      if(bytes>60000)throw new InvalidOperationException("metadata-too-large");
      while(page.Offset<page.Rows.Length&&selected.Count<limit) {
        var row=page.Rows[page.Offset];var rowBytes=Encoding.UTF8.GetByteCount(Json.Encode(row))+1;
        if(bytes+rowBytes>60000) {if(selected.Count==0)throw new InvalidOperationException("row-too-large");break;}
        selected.Add(row);page.Offset++;bytes+=rowBytes;
      }
      var result=new Dictionary<string,object>(page.Value);result[page.Field]=selected;
      result["nextCursor"]=null;
      if(page.Offset<page.Rows.Length) {
        var next=Guid.NewGuid().ToString("N");
        lock(sync){if(pages.Count>=32||pages.Values.Sum(p=>p.Rows.Length)+page.Rows.Length>200000)throw new InvalidOperationException("query-capacity-reached");pages[next]=page;}
        result["nextCursor"]=next;
      }
      return result;
    }
    public void Dispose() {
      disposed=true;pending?.Dispose();
      lock(sync){foreach(var pipe in connected.ToArray())pipe.Dispose();pages.Clear();}
      listener?.Join(3000);
    }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {public int Length;public IntPtr Descriptor;public int Inherit;}
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl,uint revision,out IntPtr descriptor,out uint size);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafePipeHandle CreateNamedPipe(string name,uint openMode,uint pipeMode,uint instances,uint outBuffer,uint inBuffer,uint timeout,ref SecurityAttributes security);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
    static NamedPipeServerStream CreatePipe(string pipeName,string[] sids,bool first) {
      var sddl="D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)"+string.Concat(sids.Select(sid=>"(A;;GRGW;;;"+sid+")"));
      if(!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl,1,out var descriptor,out _))throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        var security=new SecurityAttributes {Length=Marshal.SizeOf<SecurityAttributes>(),Descriptor=descriptor};
        // Message mode + PIPE_REJECT_REMOTE_CLIENTS. DACL additionally denies network logons.
        var handle=CreateNamedPipe(@"\\.\pipe\"+pipeName,3u|(first?0x80000u:0u),0x4|0x2|0x8,16,65536,65536,5000,ref security);
        if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
        return new NamedPipeServerStream(PipeDirection.InOut,false,false,handle);
      }finally{LocalFree(descriptor);}
    }
  }
}
