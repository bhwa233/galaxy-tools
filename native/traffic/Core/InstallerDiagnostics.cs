using System;

namespace Spark.Traffic {
  public enum InstallStep {Bootstrap=50,Caller=51,Source=52,SharedRoot=53,PrivateDirectories=54,Package=55,ServiceConfiguration=56,Grants=57,ServiceStart=58}
  public static class InstallerDiagnostics {
    public static int ExitCode(Exception error,InstallStep step) {
      switch(error.Message) {
        case "administrator-required": return 10;
        case "invalid-installer-arguments": return 11;
        case "installer-caller-mismatch": return 12;
        case "untrusted-directory-owner": return 20;
        case "directory-acl-not-protected": return 21;
        case "unsafe-directory-acl": return 22;
        case "required-directory-acl-missing": return 23;
        case "reparse-path-rejected": case "unsafe-input-file": return 24;
        case "resource-hash-mismatch": case "staged-resource-hash-mismatch": return 30;
        case "installed-resource-hash-mismatch": return 31;
        case "incomplete-resource-closure": return 32;
        case "invalid-resource-name": case "resource-manifest-too-large": return 33;
        case "service-not-installed": return 34;
      }
      if(error.Message.StartsWith("sc-failed:",StringComparison.Ordinal))return 40;
      return (int)step;
    }
    public static string Describe(int code) {
      switch(code) {
        case 10: return "未取得管理员权限，请在 Windows 权限确认框中允许安装";
        case 11: return "安装参数不完整，请重新打开流量监控后再试";
        case 12: return "无法验证发起安装的流量进程，请重新打开流量监控后再试";
        case 20: return "服务目录的所有者不是 SYSTEM 或 Administrators，已拒绝使用";
        case 21: return "服务目录仍继承外部权限，已拒绝使用";
        case 22: return "服务目录包含不符合要求的访问权限，已拒绝使用";
        case 23: return "服务目录缺少 SYSTEM 或 Administrators 完整权限";
        case 24: return "服务路径包含重解析点或不安全文件，已拒绝使用";
        case 30: return "安装文件校验失败，文件内容与发布清单不一致";
        case 31: return "已部署服务文件校验失败，请重新安装";
        case 32: return "安装文件不完整，缺少服务或运行依赖";
        case 33: return "安装资源清单无效，请重新获取插件安装包";
        case 34: return "尚未安装流量服务，请先安装服务再授予全机权限";
        case 40: return "Windows 服务配置失败，请检查服务管理器和系统日志";
        case 50: return "安装程序初始化失败";
        case 51: return "验证安装调用者时发生错误";
        case 52: return "无法安全打开插件的原生程序目录";
        case 53: return "无法创建或验证共享服务目录";
        case 54: return "无法创建或验证服务及私有历史目录";
        case 55: return "校验或暂存服务安装文件时发生错误";
        case 56: return "停止旧服务或配置 Windows 服务时发生错误";
        case 57: return "无法安全保存服务授权";
        case 58: return "流量服务未能正常启动，请检查 Windows 系统日志";
        default: return "安装程序意外退出，请查看 Windows 应用程序日志";
      }
    }
  }
}
