# iJWA's helpers in one PowerShell: smtc.ps1 (what Windows says plays), spotify-agent.ps1 (Spotify, Apple Music) and
# web-agent.ps1 (the browsers), each in a runspace of its own, side by side — a PowerShell apiece held 35–45 MB each
# (measured 2026-10-09). Lines come in as "<helper>`t<line>" and are handed to that helper, started the first time;
# what a helper says goes out the same way. "<helper>`tstart" only starts it, "<helper>`trestart" ends it (the next line
# starts it afresh); a helper that ends says {"ended":true}.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Management.Automation;
using System.Management.Automation.Runspaces;
using System.Text;

/** A helper's way out: each line it says, with its name in front. */
public class IJWATagged : TextWriter {
    readonly string tag;
    readonly TextWriter to;
    public IJWATagged(string tag, TextWriter to) { this.tag = tag; this.to = to; }
    public override Encoding Encoding { get { return Encoding.UTF8; } }
    public override void WriteLine(string line) { lock (to) { to.Write(tag + "\t" + line + "\n"); to.Flush(); } }
    public override void Flush() { }
}

public class IJWAHelper {
    public PowerShell Shell;
    public Runspace Space;
    public StreamWriter Input;
    public volatile bool Ended;
}

public static class IJWAHelpers {
    static readonly Dictionary<string, IJWAHelper> running = new Dictionary<string, IJWAHelper>();
    static TextWriter output;
    static string folder;
    // The helpers asked of now and then — Spotify's, the browsers' — end after a while unused (started again on the
    // next line), and the PowerShell gives back what it no longer uses once things are quiet (memory measured,
    // 2026-10-10: the three helpers held ~50 MB though only smtc.ps1 is needed all the time).
    static readonly Dictionary<string, DateTime> lastAsked = new Dictionary<string, DateTime>();
    static DateTime lastLine = DateTime.UtcNow;
    static bool trimmed;
    static System.Threading.Timer tidy;
    const int IdleMinutes = 5;
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern bool SetProcessWorkingSetSize(IntPtr process, IntPtr min, IntPtr max);

    public static void Begin(TextWriter to, string scripts) {
        output = to; folder = scripts;
        tidy = new System.Threading.Timer(_ => Tidy(), null, 30000, 30000);
    }

    static void Tidy() {
        var now = DateTime.UtcNow;
        List<string> idle = new List<string>();
        lock (running) {
            foreach (var name in running.Keys) {
                if (name == "smtc") continue;
                DateTime asked;
                if (!lastAsked.TryGetValue(name, out asked) || (now - asked).TotalMinutes >= IdleMinutes) idle.Add(name);
            }
        }
        foreach (var name in idle) End(name);
        // Quiet for half a minute: what the helpers no longer use goes back to Windows.
        if (idle.Count > 0) trimmed = false;
        if (!trimmed && (now - lastLine).TotalSeconds >= 30) {
            trimmed = true;
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
            SetProcessWorkingSetSize(GetCurrentProcess(), (IntPtr)(-1), (IntPtr)(-1));
        }
    }

    public static void Hand(string name, string line) {
        lock (running) { lastAsked[name] = DateTime.UtcNow; }
        lastLine = DateTime.UtcNow;
        trimmed = false;
        if (line == "restart") { End(name); return; }
        IJWAHelper helper;
        lock (running) { running.TryGetValue(name, out helper); }
        if (helper == null || helper.Ended) { End(name); helper = Start(name); }
        if (line == "start") return;
        try { helper.Input.WriteLine(line); } catch (Exception) { End(name); }
    }

    static IJWAHelper Start(string name) {
        var server = new AnonymousPipeServerStream(PipeDirection.Out);
        var client = new AnonymousPipeClientStream(PipeDirection.In, server.ClientSafePipeHandle);
        var input = new StreamWriter(server, new UTF8Encoding(false));
        input.AutoFlush = true;
        var space = RunspaceFactory.CreateRunspace();
        space.ApartmentState = System.Threading.ApartmentState.STA;
        space.Open();
        space.SessionStateProxy.SetVariable("IJWAIn", new StreamReader(client, Encoding.UTF8));
        space.SessionStateProxy.SetVariable("IJWAOut", new IJWATagged(name, output));
        var shell = PowerShell.Create();
        shell.Runspace = space;
        shell.AddScript(File.ReadAllText(Path.Combine(folder, name + ".ps1"))).AddCommand("Out-Null");
        var helper = new IJWAHelper { Shell = shell, Space = space, Input = input };
        shell.InvocationStateChanged += (sender, changed) => {
            var state = changed.InvocationStateInfo.State;
            if (state != PSInvocationState.Completed && state != PSInvocationState.Failed && state != PSInvocationState.Stopped) return;
            helper.Ended = true;
            // Only the one running says so: one ended to make room for a new one has nothing to say.
            lock (running) { IJWAHelper now; if (!running.TryGetValue(name, out now) || now != helper) return; }
            lock (output) { output.Write(name + "\t{\"ended\":true}\n"); output.Flush(); }
        };
        lock (running) { running[name] = helper; }
        shell.BeginInvoke();
        return helper;
    }

    static void End(string name) {
        IJWAHelper helper;
        lock (running) {
            if (!running.TryGetValue(name, out helper)) return;
            running.Remove(name);
        }
        // Its input closed, a helper's loop ends by itself; one held up in a long step is stopped when it's done.
        try { helper.Input.Dispose(); } catch (Exception) { }
        try { helper.Shell.BeginStop(done => { try { helper.Shell.Dispose(); helper.Space.Dispose(); } catch (Exception) { } }, null); } catch (Exception) { }
    }

    public static void EndAll() {
        List<string> names;
        lock (running) { names = new List<string>(running.Keys); }
        foreach (var name in names) End(name);
    }
}
'@ -ReferencedAssemblies System.Core, ([psobject].Assembly.Location)
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding $false))
[IJWAHelpers]::Begin($out, $PSScriptRoot)
$in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
while ($null -ne ($line = $in.ReadLine())) {
    $tab = $line.IndexOf("`t")
    if ($tab -gt 0) { [IJWAHelpers]::Hand($line.Substring(0, $tab), $line.Substring($tab + 1)) }
}
# iJWA is gone.
[IJWAHelpers]::EndAll()
