using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Net;
using System.Runtime.InteropServices;

namespace Spark.Traffic {
  public static class EndpointTables {
    [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr table,ref int size,bool order,int family,int tableClass,uint reserved);
    [DllImport("iphlpapi.dll")] static extern uint GetExtendedUdpTable(IntPtr table,ref int size,bool order,int family,int tableClass,uint reserved);
    static string Address(IntPtr row,int offset,int size,uint scope=0) { var bytes=new byte[size];Marshal.Copy(IntPtr.Add(row,offset),bytes,0,size);return size==16?new IPAddress(bytes,scope).ToString():new IPAddress(bytes).ToString(); }
    static int Port(IntPtr row,int offset) => Marshal.ReadByte(row,offset)*256+Marshal.ReadByte(row,offset+1);
    public static object[] Read(int pid,string kind,int unusedLimit) {
      if(kind!="tcp"&&kind!="udp-local")throw new ArgumentException("invalid-connection-kind");
      var rows=new List<object>();var tcp=kind=="tcp";
      foreach(var family in new[]{2,23}) {
        var size=0;var code=tcp?GetExtendedTcpTable(IntPtr.Zero,ref size,true,family,5,0):GetExtendedUdpTable(IntPtr.Zero,ref size,true,family,1,0);
        if(code!=122&&code!=0)throw new Win32Exception((int)code);
        for(var attempt=0;attempt<3;attempt++) {
          if(size<4||size>16*1024*1024)throw new InvalidOperationException("endpoint-table-too-large");
          var pointer=Marshal.AllocHGlobal(size);
          try {
            var capacity=size;code=tcp?GetExtendedTcpTable(pointer,ref size,true,family,5,0):GetExtendedUdpTable(pointer,ref size,true,family,1,0);
            if(code==122)continue;if(code!=0)throw new Win32Exception((int)code);
            var count=Marshal.ReadInt32(pointer);var stride=tcp?(family==2?24:56):(family==2?12:28);
            if(count<0||4L+(long)count*stride>capacity)throw new InvalidOperationException("invalid-endpoint-table");
            for(var i=0;i<count;i++) {
              var row=IntPtr.Add(pointer,4+i*stride);var ownerOffset=tcp?(family==2?20:52):(family==2?8:24);
              var owner=Marshal.ReadInt32(row,ownerOffset);if(pid>=0&&owner!=pid)continue;
              if(tcp) {
                var state=(System.Net.NetworkInformation.TcpState)Marshal.ReadInt32(row,family==2?0:48);
                rows.Add(Json.Obj("pid",owner,"protocol","tcp","addressFamily",family==2?"ipv4":"ipv6","localAddress",Address(row,family==2?4:0,family==2?4:16,family==2?0:unchecked((uint)Marshal.ReadInt32(row,16))),"localPort",Port(row,family==2?8:20),"remoteAddress",Address(row,family==2?12:24,family==2?4:16,family==2?0:unchecked((uint)Marshal.ReadInt32(row,40))),"remotePort",Port(row,family==2?16:44),"state",state.ToString()));
              } else rows.Add(Json.Obj("pid",owner,"protocol","udp","addressFamily",family==2?"ipv4":"ipv6","localAddress",Address(row,0,family==2?4:16,family==2?0:unchecked((uint)Marshal.ReadInt32(row,16))),"localPort",Port(row,family==2?4:20)));
            }
            break;
          }finally{Marshal.FreeHGlobal(pointer);}
        }
      }
      return rows.ToArray();
    }
    public static Dictionary<int,int[]> Counts() {
      var counts=new Dictionary<int,int[]>();
      foreach(var kind in new[]{"tcp","udp-local"})foreach(Dictionary<string,object> row in Read(-1,kind,0)) {
        var pid=(int)row["pid"];if(!counts.TryGetValue(pid,out var count))counts[pid]=count=new int[2];
        if(kind=="udp-local")count[1]++;
        else if(Json.Str(row,"state")!="Listen"&&Json.Str(row,"state")!="Closed"&&Json.Str(row,"state")!="DeleteTcb")count[0]++;
      }
      return counts;
    }
  }
}
