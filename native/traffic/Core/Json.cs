using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace Spark.Traffic {
  public static class Json {
    public static Dictionary<string, object> Obj(params object[] fields) {
      var value = new Dictionary<string, object>(StringComparer.Ordinal);
      for (var i = 0; i < fields.Length; i += 2) value[(string)fields[i]] = fields[i + 1];
      return value;
    }
    public static string Encode(object value) => new JavaScriptSerializer { MaxJsonLength = 1048576, RecursionLimit = 32 }.Serialize(value);
    public static Dictionary<string, object> Decode(string value) => new JavaScriptSerializer { MaxJsonLength = 1048576, RecursionLimit = 32 }.Deserialize<Dictionary<string, object>>(value);
    public static string Str(IDictionary<string, object> obj, string name, string fallback = "") => obj.TryGetValue(name, out var value) && value is string text ? text : fallback;
    public static int Int(IDictionary<string, object> obj, string name, int fallback, int min, int max) {
      if (!obj.TryGetValue(name, out var raw)) return fallback;
      if (!int.TryParse(Convert.ToString(raw, CultureInfo.InvariantCulture), out var value) || value < min || value > max) throw new InvalidDataException("invalid-" + name);
      return value;
    }
    public static bool Bool(IDictionary<string, object> obj, string name) => obj.TryGetValue(name, out var value) && value is bool flag && flag;
    public static Dictionary<string, object> Child(IDictionary<string, object> obj, string name) => obj.TryGetValue(name, out var value) && value is Dictionary<string, object> child ? child : Obj();
    public static string Decimal(long value) => value.ToString(CultureInfo.InvariantCulture);
    public static string Iso(DateTime value) => value.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture);
    public static long Unix(DateTime value) => new DateTimeOffset(value.ToUniversalTime()).ToUnixTimeMilliseconds();
    public static DateTime Time(long value) => DateTimeOffset.FromUnixTimeMilliseconds(value).UtcDateTime;
    public static DateTime Date(IDictionary<string, object> obj, string name, DateTime fallback) {
      var text = Str(obj, name); if (text.Length == 0) return fallback;
      if (!DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed)) throw new InvalidDataException("invalid-" + name);
      return parsed.UtcDateTime;
    }
    public static string ReadLine(TextReader reader, int maximum) {
      var buffer = new StringBuilder();
      for (;;) {
        var ch = reader.Read(); if (ch < 0) return buffer.Length == 0 ? null : throw new EndOfStreamException("truncated-message");
        if (ch == '\n') break;
        if (buffer.Length >= maximum) throw new InvalidDataException("message-too-large");
        if (ch != '\r') buffer.Append((char)ch);
      }
      var line = buffer.ToString(); if (Encoding.UTF8.GetByteCount(line) > maximum) throw new InvalidDataException("message-too-large");
      return line;
    }
    public static void AtomicWrite(string path, object value) {
      var temp = path + ".new";
      File.WriteAllText(temp, Encode(value), new UTF8Encoding(false));
      if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path);
    }
  }
}
