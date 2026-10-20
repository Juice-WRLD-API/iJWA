# Works the music pages in the user's browser for iBaila — YouTube Music, SoundCloud, YouTube — for as long as it
# runs: one process, started when a browser first plays. A browser takes no orders from other apps on Windows (no
# JavaScript from outside, as the Mac's browsers allow), so its window is read the way a screen reader does it (UI
# Automation): its tabs' titles, a page's own Play button. Only the browser's own controls are walked to find the
# tabs, never a page, so reading them costs a fraction of a second.
#
# Commands come in on the input, one JSON line each; answers go out the same way, with the command's seq:
#   {"seq":1,"do":"tabs"}                         every browser tab: { tabs: [{ app, title, selected }] }
#   {"seq":2,"do":"open","url":"…","site":"soundCloud","app":"msedge","playing":"Classy"}
#                                                 opens the page in a new tab of that browser, kept behind; the site's
#                                                 tab it replaces (the one playing, else the one shown) closes
#   {"seq":3,"do":"press","site":"soundCloud","what":"play"}   presses the site's own button in its tab: play (a
#                                                 page that doesn't start by itself), next, previous
#   {"seq":4,"do":"letload","app":"opera","title":"…","ms":2500}   a minimized or covered browser window shown unseen
#                                                 that long, so a page in it that never played loads its song
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
$A = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$Types = [System.Windows.Automation.ControlType]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
# Run by agents.ps1, lines go to and come from iBaila through it; run on its own, through the console.
if (-not $IBailaOut) { $IBailaOut = [Console]::Out }
function Say($object) { $IBailaOut.WriteLine(($object | ConvertTo-Json -Compress -Depth 5)); $IBailaOut.Flush() }

Add-Type -Namespace IBailaWeb -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
[DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int index, int value);
[DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
[DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attribute, ref int value, int size);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
/// `h` put back under `above`, the window it was under, giving no keys. A window put under one in the topmost band is
/// made topmost itself: a browser put back under iBaila's light (topmost, over the whole screen) stayed over every
/// window after (the test PC, 2026-10-12). Under a topmost window an ordinary one was the top of the ordinary ones,
/// so it goes back there instead.
public static void PutUnder(IntPtr h, IntPtr above) {
  bool aboveTopmost = (GetWindowLong(above, -20) & 0x8) != 0, topmost = (GetWindowLong(h, -20) & 0x8) != 0;
  SetWindowPos(h, aboveTopmost && !topmost ? IntPtr.Zero : above, 0, 0, 0, 0, 0x0013);
}
[DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, IntPtr extra);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
public static uint ProcessOf(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
[DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
public delegate bool EnumProc(IntPtr h, IntPtr l);
public struct Rect { public int Left, Top, Right, Bottom; }
[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
static System.Collections.Generic.Dictionary<uint, string> names = new System.Collections.Generic.Dictionary<uint, string>();
[DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr h, uint id, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
/// Opera shows UI Automation nothing of its window — no tabs, no address bar, no page — until it is asked once the
/// older way (MSAA, its window's accessible object): then all of it is there (measured in Opera, 2026-10-09).
public static void Wake(IntPtr h) {
  var iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
  object o;
  if (AccessibleObjectFromWindow(h, 0xFFFFFFFC, ref iid, out o) != 0 || o == null) return;
  try { o.GetType().InvokeMember("accChildCount", System.Reflection.BindingFlags.GetProperty, null, o, null); } catch { }
  Marshal.ReleaseComObject(o);
}
[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out int value, int size);
/// The nearest window above `h` that one can see: shown, not minimized, not cloaked, of some size (not the window just
/// above it, which may be an unseen one of no size: put back under that, a browser stayed over the window covering it).
public static IntPtr SeenAbove(IntPtr h) {
  for (IntPtr w = GetWindow(h, 3); w != IntPtr.Zero; w = GetWindow(w, 3)) {   // GW_HWNDPREV
    if (!IsWindowVisible(w) || IsIconic(w)) continue;
    int cloaked;
    if (DwmGetWindowAttribute(w, 14, out cloaked, 4) == 0 && cloaked != 0) continue;   // DWMWA_CLOAKED
    Rect r;
    GetWindowRect(w, out r);
    if (r.Right - r.Left < 50 || r.Bottom - r.Top < 50) continue;
    return w;
  }
  return IntPtr.Zero;
}
/// The browser's window showing the tab titled `title` (a window is named after the tab it shows), else its only
/// window; nothing when it has none or several and none is so named. Minimized ones too.
public static IntPtr BrowserWindowOf(string process, string title) {
  IntPtr named = IntPtr.Zero, any = IntPtr.Zero;
  int count = 0;
  EnumWindows(delegate(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;   // GW_OWNER
    var kind = new System.Text.StringBuilder(64);
    GetClassName(h, kind, 64);
    if (kind.ToString() != "Chrome_WidgetWin_1") return true;
    if (!IsIconic(h)) {
      Rect r;
      GetWindowRect(h, out r);
      if (r.Right - r.Left < 300 || r.Bottom - r.Top < 200) return true;
    }
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    string name;
    if (!names.TryGetValue(pid, out name)) {
      try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { name = ""; }
      names[pid] = name;
    }
    if (!string.Equals(name, process, StringComparison.OrdinalIgnoreCase)) return true;
    var text = new System.Text.StringBuilder(512);
    GetWindowText(h, text, 512);
    if (named == IntPtr.Zero && title.Length > 0 && text.ToString().IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) named = h;
    if (any == IntPtr.Zero) any = h;
    count++;
    return true;
  }, IntPtr.Zero);
  return named != IntPtr.Zero ? named : count == 1 ? any : IntPtr.Zero;
}
[StructLayout(LayoutKind.Sequential)] struct KeyInput { public ushort Vk; public ushort Scan; public uint Flags; public uint Time; public IntPtr Extra; }
[StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X; public int Y; public uint Data; public uint Flags; public uint Time; public IntPtr Extra; }
[StructLayout(LayoutKind.Explicit)] struct AnyInput { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyInput Key; }
[StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public AnyInput Any; }
[DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] inputs, int size);
/// Text typed as its letters (KEYEVENTF_UNICODE), whatever keyboard layout is on.
public static void Type(string text) {
  var keys = new Input[text.Length * 2];
  for (int i = 0; i < text.Length; i++) {
    keys[2 * i].Type = 1; keys[2 * i].Any.Key.Scan = text[i]; keys[2 * i].Any.Key.Flags = 4;
    keys[2 * i + 1].Type = 1; keys[2 * i + 1].Any.Key.Scan = text[i]; keys[2 * i + 1].Any.Key.Flags = 4 | 2;
  }
  SendInput((uint)keys.Length, keys, Marshal.SizeOf(typeof(Input)));
}
/// The top browser window on the screen (minimized too), else nothing: a few window lookups, no UI Automation.
public static IntPtr BrowserShown(string pattern) {
  IntPtr found = IntPtr.Zero;
  var browsers = new System.Text.RegularExpressions.Regex(pattern);
  EnumWindows(delegate(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    var kind = new System.Text.StringBuilder(64);
    GetClassName(h, kind, 64);
    if (kind.ToString() != "Chrome_WidgetWin_1" && kind.ToString() != "MozillaWindowClass") return true;
    // A browser's own window: no owner, and a window's size. Not one of its bubbles — Edge, after closing badly, shows
    // "Restore pages" before its window, and that one was taken for it (2026-10-09).
    if (GetWindow(h, 4) != IntPtr.Zero) return true;   // GW_OWNER
    Rect r;
    GetWindowRect(h, out r);
    if (r.Right - r.Left < 300 || r.Bottom - r.Top < 200) return true;
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    string name;
    if (!names.TryGetValue(pid, out name)) {
      try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { name = ""; }
      names[pid] = name;
    }
    if (!browsers.IsMatch(name)) return true;
    found = h;
    return false;
  }, IntPtr.Zero);
  return found;
}
'@

$Browsers = '^(chrome|msedge|firefox|brave|opera|vivaldi|arc)$'

# A tab's title says its site: "Song - YouTube Music", "Stream … | Listen online for free on SoundCloud" (and while it
# plays, "▶ Song by Someone"), "Video - YouTube".
function SiteOf([string]$title) {
  if ($title -match 'YouTube Music') { return 'youTubeMusic' }
  if ($title -match 'SoundCloud' -or $title -match '^\s*[\u25B6\u25BA]') { return 'soundCloud' }
  if ($title -match '[-\u2013] YouTube\b') { return 'youTube' }
  if ($title -match 'Spotify\s*[-\u2013]\s*Web Player') { return 'spotifyWeb' }
  return $null
}

# The browser windows open, top one first, and each one's tabs (their elements kept for pressing).
function Windows {
  $names = @{}
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match $Browsers } | ForEach-Object { $names[$_.Id] = $_.ProcessName }
  $found = @()
  if ($names.Count -eq 0) { return $found }
  foreach ($w in $A::RootElement.FindAll($Scope::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    $c = $w.Current
    if (-not $names.ContainsKey($c.ProcessId)) { continue }
    $w = Woken $w ([IntPtr]$c.NativeWindowHandle)
    $tabs = @(TabsIn $w)
    # A minimized window shows no tabs: its name is the tab it shows ("Song by Someone and 3 more pages - Microsoft Edge").
    if ($tabs.Count -eq 0 -and [string]$c.Name) { $tabs = @(@{ element = $null; title = [string]$c.Name; selected = $true; site = (SiteOf ([string]$c.Name)) }) }
    if ($tabs.Count -eq 0) { continue }
    $found += @{ element = $w; app = $names[$c.ProcessId]; pid = $c.ProcessId; handle = [IntPtr]$c.NativeWindowHandle; tabs = $tabs }
  }
  return $found
}

# A browser's window as UI Automation sees it. Opera's shows nothing at all — not even its title bar — until woken
# (Wake): woken then, and looked at afresh. Never another's: woken, Edge's elements went stale under iBaila.
function Woken($element, $handle) {
  if ($walker.GetFirstChild($element)) { return $element }
  [IBailaWeb.Win]::Wake($handle)
  return [System.Windows.Automation.AutomationElement]::FromHandle($handle)
}

# The tabs of one window: its own controls walked, pages and toolbars passed by.
function TabsIn($window) {
  $tabs = @()
  $stack = New-Object System.Collections.Stack
  $stack.Push(@($window, 0))
  while ($stack.Count) {
    $pair = $stack.Pop()
    $child = $walker.GetFirstChild($pair[0])
    while ($child) {
      $type = $child.Current.ControlType
      if ($type -eq $Types::TabItem) {
        $name = [string]$child.Current.Name
        $selected = $false
        try { $selected = $child.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected } catch { }
        $tabs += @{ element = $child; title = $name; selected = [bool]$selected; site = (SiteOf $name) }
      } elseif ($type -ne $Types::Document -and $type -ne $Types::ToolBar -and $pair[1] -lt 12) {
        $stack.Push(@($child, $pair[1] + 1))
      }
      $child = $walker.GetNextSibling($child)
    }
  }
  return $tabs
}

function Plain([string]$text) { return (($text.ToLowerInvariant() -replace '\s*[\(\[].*?[\)\]]', '') -replace '[^\p{L}\p{N}]+', ' ').Trim() }

function Tabs($c) {
  $list = @()
  foreach ($w in (Windows)) { foreach ($t in $w.tabs) { $list += @{ app = $w.app; title = $t.title; selected = $t.selected } } }
  return @{ tabs = $list }
}

# ---- opening a page ----

# The browser has to be shown a moment to take a new tab; it is made see-through meanwhile, without its window's
# animations, so nothing seems to happen but the music changing.
function SeeThrough($handle, $on) {
  if (-not $handle -or $handle -eq [IntPtr]::Zero) { return }
  $style = [IBailaWeb.Win]::GetWindowLong($handle, -20)
  $off = [int]$on
  $null = [IBailaWeb.Win]::DwmSetWindowAttribute($handle, 3, [ref]$off, 4)
  # Layered at no opacity, and passing clicks through (WS_EX_TRANSPARENT): there, but neither seen nor in the way.
  if ($on) { $null = [IBailaWeb.Win]::SetWindowLong($handle, -20, $style -bor 0x80020); $null = [IBailaWeb.Win]::SetLayeredWindowAttributes($handle, 0, 0, 2) }
  else { $null = [IBailaWeb.Win]::SetLayeredWindowAttributes($handle, 0, 255, 2); $null = [IBailaWeb.Win]::SetWindowLong($handle, -20, $style -band (-bnot 0x80020)) }
}

# Whether the keyboard is at `$element` or inside it. Keys go wherever the keyboard is, and Windows doesn't always let
# iBaila bring a browser forward: with Search in front (the test machine, 2026-10-09), an address meant for Opera was
# typed into Search, and its Enter opened a page in Edge — on the desktop, Ctrl+A and Delete would have binned files.
# So no key is pressed before this says yes.
function FocusIn($element) {
  try {
    $want = $element.GetRuntimeId() -join '.'
    $at = [System.Windows.Automation.AutomationElement]::FocusedElement
    for ($i = 0; $at -and $i -lt 40; $i++) {
      if (($at.GetRuntimeId() -join '.') -eq $want) { return $true }
      $at = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($at)
    }
  } catch { }
  return $false
}

# Whether the window in front is `$handle` or another of its browser's — a page's "Chrome Legacy Window" takes the
# front by itself, a window of its own.
function InFront($handle) {
  $now = [IBailaWeb.Win]::GetForegroundWindow()
  if ($now -eq [IntPtr]::Zero) { return $false }
  if ($now -eq $handle) { return $true }
  $mine = [IBailaWeb.Win]::ProcessOf($handle)
  return $mine -ne 0 -and [IBailaWeb.Win]::ProcessOf($now) -eq $mine
}

# The keys back to the window the user was in. Windows lets a program in the background hand them on only just after
# a key is pressed: F24, on no keyboard, is pressed first.
function GiveBack($front) {
  # No window was in front (as just after Search closes): the keyboard goes to the desktop, never kept by the browser.
  if (-not $front -or $front -eq [IntPtr]::Zero) { $front = [IBailaWeb.Win]::GetShellWindow() }
  if ($front -eq [IntPtr]::Zero) { return }
  [IBailaWeb.Win]::keybd_event(0x87, 0, 0, [IntPtr]::Zero); [IBailaWeb.Win]::keybd_event(0x87, 0, 2, [IntPtr]::Zero)
  $null = [IBailaWeb.Win]::SetForegroundWindow($front)
}

# The tab's own close button ("Close tab", whatever the language): known by its kind (TabCloseButton,
# EdgeTabCloseButton), else the tab's last button — a tab playing sound has its mute button first.
function CloseTab($tab) {
  if (-not $tab) { return $false }
  # Its buttons: Chrome's and Edge's are its own children, Opera's lie a level or two deeper.
  $buttons = @($tab.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $Types::Button))))
  $close = $buttons | Where-Object { $_.Current.ClassName -match 'Close' } | Select-Object -First 1
  if (-not $close -and $buttons.Count) { $close = $buttons[$buttons.Count - 1] }
  if (-not $close) { return $false }
  try { $close.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch { return $false }
}

# A tab's title as the page has it: a minimized window's name adds "and 4 more pages - Profile 1 - Microsoft Edge", a
# tab's own name in Edge "- Memory usage - 40 MB".
# Closes a tab shown first: picked, so its close button is there, then closed.
function CloseShown($tab) {
  try { $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() } catch { }
  Start-Sleep -Milliseconds 250
  $closed = CloseTab $tab
  Start-Sleep -Milliseconds 200
  return $closed
}

function TitleOf([string]$name) {
  $t = $name -replace '\s+and \d+ more (pages?|tabs?).*$', '' -replace '\s+-\s+(Profile \d+|Memory usage).*$', ''
  return ($t -replace '\s+-\s+(Microsoft.{0,2}\s?Edge|Google Chrome|Brave|Opera|Vivaldi|Mozilla Firefox)$', '').Trim()
}
function SameTitle([string]$a, [string]$b) {
  $x = Plain (TitleOf $a); $y = Plain (TitleOf $b)
  if ($x.Length -lt 4 -or $y.Length -lt 4) { return $false }
  return $x -eq $y -or $x.StartsWith($y) -or $y.StartsWith($x)
}

function Open($c) {
  $url = [string]$c.url; $site = [string]$c.site; $wantApp = [string]$c.app
  $playing = Plain ([string]$c.playing)
  $front = [IBailaWeb.Win]::GetForegroundWindow()
  $windows = @(Windows)
  # The browser played in, else the one with the site open, else the first open.
  $mine = @($windows | Where-Object { $_.app -eq $wantApp })
  if ($mine.Count -eq 0) { $mine = @($windows | Where-Object { @($_.tabs | Where-Object { $_.site -eq $site }).Count -gt 0 }) }
  if ($mine.Count -eq 0) { $mine = $windows }

  # The site's tab this page replaces: the one playing the song, else the one shown in its window, else any. A
  # minimized window shows only its name: the tab is known by its title, and found once the window shows.
  $old = $null
  $ofSite = @(); foreach ($w in $mine) { foreach ($t in $w.tabs) {
    $named = $playing -and (Plain $t.title).Contains($playing)
    if ($named -or $t.site -eq $site -or ($site -eq 'youTube' -and $t.site -eq 'youTubeMusic')) { $ofSite += $t } } }
  if ($playing) { $old = $ofSite | Where-Object { (Plain $_.title).Contains($playing) } | Select-Object -First 1 }
  if (-not $old) { $old = $ofSite | Where-Object { $_.selected } | Select-Object -First 1 }
  if (-not $old) { $old = $ofSite | Select-Object -First 1 }

  $oldPage = $null
  $how = ''
  if ($mine.Count -eq 0) {
    # No browser open: the default one starts with the page — out of sight. It came up over everything (a friend's PC
    # and the test machine, 2026-10-09). Asked to start minimized, which a browser may or may not do, its window is
    # caught the moment it shows either way: made see-through and given no keys, it's worked like a minimized one —
    # its page let start, turned up, pressed — and minimized after, as one put away by hand.
    Start-Process $url -WindowStyle Minimized
    $h = [IntPtr]::Zero
    $until = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $until) {
      $h = [IBailaWeb.Win]::BrowserShown($Browsers)
      if ($h -ne [IntPtr]::Zero) { break }
      Start-Sleep -Milliseconds 10
    }
    if ($h -eq [IntPtr]::Zero) { return @{ ok = $true; opened = 'browser'; state = 'not seen' } }
    SeeThrough $h $true
    if ([IBailaWeb.Win]::IsIconic($h)) { $null = [IBailaWeb.Win]::ShowWindow($h, 4) }   # SW_SHOWNOACTIVATE
    GiveBack $front
    $target = @{ element = (Woken ([System.Windows.Automation.AutomationElement]::FromHandle($h)) $h); handle = $h }
    $state = 'minimized'
    $before = @()
    $how = 'a new browser'
  } else {
    # The browser's most recent window takes the tab. Unless the user is looking at it, it is shown first — unseen, letting
    # clicks through, without taking the keys — for as long as its pages are worked: a minimized browser opens a page in
    # its minimized window, and shows nothing of a page that isn't playing.
    $target = $mine[0]
    $h = $target.handle
    $state = if ([IBailaWeb.Win]::IsIconic($h)) { 'minimized' } elseif ($front -eq $h) { 'front' } else { 'behind' }
    $aboveIt = [IBailaWeb.Win]::GetWindow($h, 3)
    if ($state -ne 'front') {
      SeeThrough $h $true
      if ($state -eq 'minimized') { $null = [IBailaWeb.Win]::ShowWindow($h, 4) }   # SW_SHOWNOACTIVATE
      $null = [IBailaWeb.Win]::SetWindowPos($h, [IntPtr]0, 0, 0, 0, 0, 0x0013)    # on top of the others, no keys
      Start-Sleep -Milliseconds 350
    }
    $target.element = Woken $target.element $h
    $before = @(TabsIn $target.element)
    # The site's tab, now that the tabs can be read: the one of its title.
    if ($old -and -not $old.element) {
      $match = $before | Where-Object { $_.element -and (SameTitle $_.title $old.title) } | Sort-Object { -not $_.selected } | Select-Object -First 1
      if ($match) { $old = $match }
    }
    # The page it showed, to know the new one when it comes.
    if ($old -and $old.element) {
      # One tab of the site plays: it goes to the page itself, as one would type the address — picked, its address bar
      # filled, Enter — never a tab more. Paused already, it goes without asking "Leave site?".
      try { $old.element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() } catch { }
      Start-Sleep -Milliseconds 250
      $oldPage = PageOf $target.element $site 1
      $bar = $target.element.FindFirst($Scope::Descendants, $addressCondition)
      if ($bar) {
        try {
          $bar.SetFocus()
          $filled = $true
          try { $bar.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($url) } catch { $filled = $false }
          if (-not (FocusIn $bar)) {
            [IBailaWeb.Win]::keybd_event(0x87, 0, 0, [IntPtr]::Zero); [IBailaWeb.Win]::keybd_event(0x87, 0, 2, [IntPtr]::Zero)
            $null = [IBailaWeb.Win]::SetForegroundWindow($h)
            $bar.SetFocus()
          }
          # Keys only while the address bar has them: else the new tab below — never a key pressed elsewhere.
          if (-not $filled -and (FocusIn $bar)) {
            # Opera's address field won't be set (E_FAIL, 2026-10-09): the address is typed into it instead, as
            # letters whatever the keyboard — all it held chosen and typed over, then what it offers to add after
            # the address (one from before) taken away.
            [IBailaWeb.Win]::keybd_event(0x11, 0, 0, [IntPtr]::Zero); [IBailaWeb.Win]::keybd_event(0x41, 0, 0, [IntPtr]::Zero)
            [IBailaWeb.Win]::keybd_event(0x41, 0, 2, [IntPtr]::Zero); [IBailaWeb.Win]::keybd_event(0x11, 0, 2, [IntPtr]::Zero)
            [IBailaWeb.Win]::Type($url)
            Start-Sleep -Milliseconds 80
            [IBailaWeb.Win]::keybd_event(0x2E, 0, 0, [IntPtr]::Zero); [IBailaWeb.Win]::keybd_event(0x2E, 0, 2, [IntPtr]::Zero)
            $filled = $true
          }
          if ($filled -and (FocusIn $bar)) {
            [IBailaWeb.Win]::keybd_event(0x0D, 0, 0, [IntPtr]::Zero); [IBailaWeb.Win]::keybd_event(0x0D, 0, 2, [IntPtr]::Zero)
            $how = 'its tab'
          }
        } catch { }
        Start-Sleep -Milliseconds 120
      }
    }
    if (-not $how) {
      # No tab of the site (or one that can't be told where to go): a new tab of the browser.
      $exe = (Get-Process -Id $target.pid).Path
      if ($exe) { Start-Process -FilePath $exe -ArgumentList $url } else { Start-Process $url }
      $how = 'a new tab'
      for ($i = 0; $i -lt 50; $i++) {
        Start-Sleep -Milliseconds 100
        if ($state -ne 'front' -and (InFront $h)) { GiveBack $front }
        if (@(TabsIn $target.element).Count -gt $before.Count) { break }
      }
    }
    # Should the browser have taken the keys, they go straight back to the window the user was in.
    if ($state -ne 'front') { GiveBack $front }
  }
  $closed = $false
  # Opened beside it — the address couldn't be typed, the keyboard not the browser's — the site's tab it replaces is
  # closed by its own ✕ once the new one is there, so the tabs don't pile up (Opera, 2026-10-09).
  # Opera shows a tab's ✕ only on the tab picked: it's picked first, then the new one picked again.
  if ($how -eq 'a new tab' -and $old -and $old.element) {
    $now = @(TabsIn $target.element)
    if ($now.Count -gt $before.Count) {
      $seen = @{}; foreach ($t in $before) { if ($t.element) { $seen[($t.element.GetRuntimeId() -join '.')] = $true } }
      $fresh = $now | Where-Object { $_.element -and -not $seen.ContainsKey(($_.element.GetRuntimeId() -join '.')) } | Select-Object -First 1
      $closed = CloseShown $old.element
      if ($fresh) { try { $fresh.element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() } catch { } }
    }
  }

  # A page that doesn't start by itself (SoundCloud's) has its own Play pressed once the new page is there — not the
  # one it showed before, and, for a song, the song's own (its name in the page's title). Its own Play is the largest
  # button that says Play or Pause, never a smaller one of the lists beside it; once pressed, it turns to Pause. Not
  # turned after a few seconds, it is pressed once more — never sooner, or the second press would pause the first's.
  $pressed = ''
  $wanted = Plain ([string]$c.title)
  $oldID = if ($oldPage) { ($oldPage.GetRuntimeId() -join '.') } else { '' }
  if ([string]$c.press -eq 'play') {
    $deadline = (Get-Date).AddSeconds(14)
    $presses = 0; $pressedAt = $null
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 500
      $page = $target.element.FindFirst($Scope::Descendants, $documentCondition)
      if (-not $page -or ($oldID -and ($page.GetRuntimeId() -join '.') -eq $oldID)) { continue }
      if ($wanted -and -not (Plain ([string]$page.Current.Name)).Contains($wanted)) { continue }
      $hero = HeroIn $page
      if (-not $hero) { continue }
      if (([string]$hero.Current.Name).Trim().ToLowerInvariant() -match $Playing) { if (-not $pressed) { $pressed = 'already playing' }; break }
      if ($pressedAt -and ((Get-Date) - $pressedAt).TotalSeconds -lt 4) { continue }
      if ($presses -ge 2) { break }
      # Pressed once: whether it started, Windows' word on what plays says (iBaila looks); the page's own button keeps
      # saying Play on SoundCloud, and a second press would skip on.
      try { $hero.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $pressed = [string]$hero.Current.Name; break } catch { }
    }
  }

  # The page's own volume, turned full. A browser plays a page only as loud as the page's own slider, beneath iBaila's
  # volume and Windows' — low there, a song stayed quiet with both of those up (a friend's PC, 2026-10-09). The site's
  # own keys turn it up, ten presses reaching the top from anywhere: YouTube Music's "=", SoundCloud's Shift+Up
  # (measured in Edge: YouTube Music went from a fifth of full to full; its slider isn't there for UI Automation).
  $louder = @{ youTubeMusic = '='; soundCloud = '+{UP}' }[$site]
  if ($louder) {
    $page = $null
    $until = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $until) {
      $page = $target.element.FindFirst($Scope::Descendants, $documentCondition)
      if ($page -and -not ($oldID -and ($page.GetRuntimeId() -join '.') -eq $oldID)) { break }
      $page = $null
      Start-Sleep -Milliseconds 300
    }
    if ($page) {
      Start-Sleep -Milliseconds 1200   # its player made
      [IBailaWeb.Win]::keybd_event(0x87, 0, 0, [IntPtr]::Zero); [IBailaWeb.Win]::keybd_event(0x87, 0, 2, [IntPtr]::Zero)
      $null = [IBailaWeb.Win]::SetForegroundWindow($h)
      try { $page.SetFocus(); if (FocusIn $page) { [System.Windows.Forms.SendKeys]::SendWait($louder * 10) } } catch { }
      if ($state -ne 'front') { GiveBack $front }
    }
  }

  $after = @(TabsIn $target.element)
  # Minimized again the moment a song starts, SoundCloud moves on to the next in its queue (seen 2026-10-09): the song
  # is given a few seconds to settle first, the browser unseen meanwhile.
  if ($pressed -and $pressed -ne 'already playing' -and $state -ne 'front') { Start-Sleep -Milliseconds 3500 }
  # The browser goes back to where it was.
  if ($state -ne 'front') {
    if ($state -eq 'minimized') { $null = [IBailaWeb.Win]::ShowWindow($h, 7) }   # SW_SHOWMINNOACTIVE
    elseif ($aboveIt -and $aboveIt -ne [IntPtr]::Zero) { [IBailaWeb.Win]::PutUnder($h, $aboveIt) }   # under the window it was under, no keys
    Start-Sleep -Milliseconds 150
    SeeThrough $h $false
    # Minimized without letting go of the keyboard, a browser kept it: the next key the user pressed went to its hidden
    # page — Space paused the song (the test machine, 2026-10-09). Given back once more should it still have it.
    if (InFront $h) { GiveBack $front }
  }
  return @{ ok = $true; opened = $how; closed = $closed; replaced = $(if ($old) { TitleOf $old.title } else { '' }); pressed = $pressed;
    state = $state; tabs = "$($before.Count) before, $($after.Count) after" }
}

# ---- pressing a page's own buttons ----

# The words a site's buttons wear, in the languages it speaks: whole names only, so "Play current" and "Play all" are
# told apart from the page's own "Play".
$Words = @{
  play     = '^(play|oynat|lecture|wiedergabe|abspielen|reproducir|riproduci|reproduzir|afspelen|spela|odtw\u00F3rz|\u0432\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u0435\u0441\u0442\u0438)( \(k\))?$'
  next     = '^(skip to next|next|sonraki|next \(shift\+n\)|sonraki \(shift\+n\))$'
  previous = '^(skip to previous|previous|\u00F6nceki|previous \(shift\+p\)|\u00F6nceki \(shift\+p\))$'
}

# The page of the site a window shows. A browser lets go of its pages' accessibility after a while without a reader,
# and builds it again when asked: the first answer may hold no page, so it is asked again a few times.
$documentCondition = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $Types::Document)
# The address bar: Chrome's, Edge's and Brave's (OmniboxViewViews), Opera's (AddressTextfieldView).
$addressCondition = New-Object System.Windows.Automation.OrCondition(
  (New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'OmniboxViewViews')),
  (New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'AddressTextfieldView')))
function PageOf($window, [string]$site, [int]$tries = 5) {
  for ($try = 0; $try -lt $tries; $try++) {
    if ($try) { Start-Sleep -Milliseconds 400 }
    $pages = @($window.FindAll($Scope::Descendants, $documentCondition))
    foreach ($d in $pages) { if ((SiteOf ([string]$d.Current.Name)) -eq $site) { return $d } }
    # Pages there, none of the site's: asking again won't change that.
    if ($pages.Count) { return $null }
  }
  return $null
}

# Presses the first button in a page that wears the word, in the page's order: the page's own (a track's, a set's),
# above the lists below it. A browser behind other windows calls every button off the screen: only one with no size at
# all is passed over. Answers the button's name, or nothing.
# For Play, the page's own button is the first that says Play or Pause: saying Pause, the page plays already, and
# nothing is pressed — never a Play further down, another track's. Answers the name pressed, 'playing', or nothing.
$Playing = '^(pause|duraklat|pausa|pauze|pausieren|mettre en pause|wstrzymaj)( \(k\))?$'
# The page's own Play (or Pause, while it plays): the largest button that says so — a track's or a set's at the head of
# its page, not the smaller ones of the lists beside it or the player bar's "Play current".
function HeroIn($page) {
  $best = $null; $area = 0
  foreach ($b in $page.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $Types::Button)))) {
    $name = ([string]$b.Current.Name).Trim().ToLowerInvariant()
    if ($name -notmatch $Words['play'] -and $name -notmatch $Playing) { continue }
    $box = $b.Current.BoundingRectangle
    if ($box.IsEmpty -or $box.Width -le 0 -or $box.Height -le 0) { continue }
    if ($box.Width * $box.Height -gt $area) { $area = $box.Width * $box.Height; $best = $b }
  }
  return $best
}

# Whether the page's own button says Pause (it plays) or Play (it doesn't), without pressing it.
function StateIn($page) {
  foreach ($b in $page.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $Types::Button)))) {
    $name = ([string]$b.Current.Name).Trim().ToLowerInvariant()
    $box = $b.Current.BoundingRectangle
    if ($box.IsEmpty -or $box.Width -le 0 -or $box.Height -le 0) { continue }
    if ($name -match $Playing) { return 'playing' }
    if ($name -match $Words['play']) { return 'paused' }
  }
  return ''
}

function PressIn($page, $pattern) {
  $buttons = $page.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $Types::Button)))
  $isPlay = $pattern -eq $Words['play']
  foreach ($b in $buttons) {
    $name = ([string]$b.Current.Name).Trim().ToLowerInvariant()
    $box = $b.Current.BoundingRectangle
    if ($box.IsEmpty -or $box.Width -le 0 -or $box.Height -le 0) { continue }
    if ($isPlay -and $name -match $Playing) { return 'playing' }
    if ($name -notmatch $pattern) { continue }
    try { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return [string]$b.Current.Name } catch { return '' }
  }
  return ''
}

# A browser the user isn't in takes the keyboard when one of its page's buttons is pressed (Chromium focuses what it
# presses) — even minimized: the next key went to the hidden page (the test machine, 2026-10-09). Given back.
function LetGo($handle, $front) {
  if ($handle -eq $front) { return }
  Start-Sleep -Milliseconds 150
  if (InFront $handle) { GiveBack $front }
}

function Press($c) {
  $site = [string]$c.site; $what = [string]$c.what
  $pattern = $Words[$what]
  if (-not $pattern) { return @{ ok = $false; error = 'unknown' } }
  $front = [IBailaWeb.Win]::GetForegroundWindow()
  $seen = @()
  foreach ($w in (Windows)) {
    # The page the window shows — a minimized window's too — is the site's? Else its tab is shown first, unless the
    # user is looking at that window.
    $page = PageOf $w.element $site
    $seen += "window: $($w.app) $($w.tabs.Count) tabs; page: $(if ($page) { $page.Current.Name } else { 'none' })"
    if (-not $page) {
      $tab = $w.tabs | Where-Object { $_.site -eq $site -and $_.element } | Select-Object -First 1
      if (-not $tab -or $w.handle -eq $front) { continue }
      try { $tab.element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() } catch { continue }
      Start-Sleep -Milliseconds 500
      $page = PageOf $w.element $site
      if (-not $page) { continue }
    }
    if ($what -eq 'play') {
      $hero = HeroIn $page
      if (-not $hero) { continue }
      if (([string]$hero.Current.Name).Trim().ToLowerInvariant() -match $Playing) { return @{ ok = $true; pressed = 'playing'; page = [string]$page.Current.Name } }
      try { $hero.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch { continue }
      LetGo $w.handle $front
      return @{ ok = $true; pressed = [string]$hero.Current.Name; page = [string]$page.Current.Name }
    }
    $pressed = PressIn $page $pattern
    if ($pressed) { LetGo $w.handle $front; return @{ ok = $true; pressed = $pressed; page = [string]$page.Current.Name } }
  }
  return @{ ok = $false; error = 'no button'; seen = ($seen -join ' // ') }
}

# ---- a hidden browser page let load ----

# A page that never played, in a minimized window or one covered by others, doesn't load its song: Chromium keeps a
# hidden page's media from loading until the page is first seen (the test machine, 2026-10-10: unstarted at 0:15 until
# Opera was shown — minimized, and behind a maximized window alike). Its window shown unseen a moment — see-through,
# letting clicks through, never taking the keys — the song loads at once; put back, it plays on (measured). Shown no
# longer than asked, whatever becomes of iBaila meanwhile.
function LetLoad($c) {
  $front = [IBailaWeb.Win]::GetForegroundWindow()
  $h = [IBailaWeb.Win]::BrowserWindowOf([string]$c.app, [string]$c.title)
  if ($h -eq [IntPtr]::Zero) { return @{ ok = $true; shown = $false } }
  $ms = [Math]::Min([Math]::Max([int]$c.ms, 500), 6000)
  if ([IBailaWeb.Win]::IsIconic($h)) {
    SeeThrough $h $true
    $null = [IBailaWeb.Win]::ShowWindow($h, 4)   # SW_SHOWNOACTIVATE
    if (InFront $h) { GiveBack $front }
    Start-Sleep -Milliseconds $ms
    $null = [IBailaWeb.Win]::ShowWindow($h, 7)   # SW_SHOWMINNOACTIVE
    Start-Sleep -Milliseconds 150
    SeeThrough $h $false
    if (InFront $h) { GiveBack $front }
    return @{ ok = $true; shown = $true; was = 'minimized' }
  }
  # Covered: raised over the others it stays unseen to Chromium (measured: see-through, even in the topmost band). As a
  # minimized one is, it is minimized and shown again, unseen — a window shown again is seen — then put back under the
  # window it was under.
  $above = [IBailaWeb.Win]::SeenAbove($h)
  SeeThrough $h $true
  $null = [IBailaWeb.Win]::ShowWindow($h, 7)   # SW_SHOWMINNOACTIVE
  Start-Sleep -Milliseconds 150
  $null = [IBailaWeb.Win]::ShowWindow($h, 4)   # SW_SHOWNOACTIVATE
  if (InFront $h) { GiveBack $front }
  Start-Sleep -Milliseconds $ms
  if ($above -ne [IntPtr]::Zero) { [IBailaWeb.Win]::PutUnder($h, $above) }
  # The window the user was in in front again, whatever else came up meanwhile.
  if ($front -ne [IntPtr]::Zero -and $front -ne $h) { GiveBack $front }
  Start-Sleep -Milliseconds 100
  SeeThrough $h $false
  return @{ ok = $true; shown = $true; was = 'covered' }
}

# ---- the input ----

Say @{ ready = $true }
$stdin = if ($IBailaIn) { $IBailaIn } else { New-Object System.IO.StreamReader([Console]::OpenStandardInput()) }
while ($true) {
  $text = $stdin.ReadLine()
  if ($null -eq $text) { exit }   # iBaila is gone
  if (-not $text.Trim()) { continue }
  try { $c = $text | ConvertFrom-Json } catch { continue }
  $answer = $null
  try {
    if ($c.do -eq 'tabs') { $answer = Tabs $c }
    elseif ($c.do -eq 'open') { $answer = Open $c }
    elseif ($c.do -eq 'press') { $answer = Press $c }
    elseif ($c.do -eq 'letload') { $answer = LetLoad $c }
  } catch { $answer = @{ ok = $false; error = "$_" } }
  if ($answer) { $answer.seq = $c.seq; Say $answer }
}
