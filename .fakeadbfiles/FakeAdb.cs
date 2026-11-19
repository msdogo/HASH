using System;
using System.IO;
using System.Text;

// 测试替身：模拟 adb 的可执行文件。
// 关键点：它是一个真正的 .exe，能接受任意 argv（node.exe 会拒绝 -s）。
class FakeAdb {
  static int Main(string[] args) {
    string logPath = Environment.GetEnvironmentVariable("FAKE_ADB_LOG");
    if (!string.IsNullOrEmpty(logPath)) {
      File.AppendAllText(logPath, string.Join("\u0001", args) + "\n");
    }
    bool isPush = Array.IndexOf(args, "push") >= 0;
    bool isPull = Array.IndexOf(args, "pull") >= 0;
    bool isStat = Array.IndexOf(args, "stat") >= 0 || Array.Exists(args, a => a.Contains("stat"));
    if (isPush) {
      Console.Error.Write("a.bin: 1 file pushed, 0 skipped. 1.0 MB/s (1024 bytes in 0.001s)\r\n");
      return 0;
    }
    if (isPull) {
      // 模拟 pull：把目标参数（去掉 -s serial 后最后一个）当作要写的文件
      string dest = args[args.Length - 1];
      try { File.WriteAllText(dest, "pulled-content"); } catch { }
      Console.Error.Write("x.bin: 1 file pulled, 0 skipped. 1.0 MB/s (14 bytes in 0.001s)\r\n");
      return 0;
    }
    if (isStat) {
      Console.Out.Write("0");
      return 0;
    }
    return 0;
  }
}
