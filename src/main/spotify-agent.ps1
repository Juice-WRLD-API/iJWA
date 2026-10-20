# Plays albums and songs in the Spotify app, and reads the IDs of the song playing there, for as long as iJWA
# runs: one process, started once, so a click costs no PowerShell start. Spotify takes no orders from other apps, so
# its own window is read and its Play buttons pressed the way a screen reader does it (UI Automation). Each look
# into Spotify's window fetches everything it needs in one go (a cache request), not one question per element.
#
# Commands come in on the input, one JSON line each; answers go out the same way, with the command's seq:
#   {"seq":1,"do":"play","kind":"track","id":"<22 chars>","title":"Creepin'"}     a song by its Spotify ID: its album
#                                                 opens with the song marked, and the song's own Play button is pressed
#   {"seq":2,"do":"play","kind":"album","title":"Issa Album","artist":"21 Savage"} found through Spotify's search
#   {"seq":3,"do":"now","title":"Starboy"}        the IDs of the song playing, its album and artists: { track, album, artists }
# A play that is still looking when another play comes in gives way to it: { ok: false, error: "superseded" }.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$Types = [System.Windows.Automation.ControlType]
$ValueProperty = [System.Windows.Automation.ValuePattern]::ValueProperty
# Run by agents.ps1, lines go to and come from iJWA through it; run on its own, through the console.
if (-not $IJWAOut) { $IJWAOut = [Console]::Out }
function Say($object) { $IJWAOut.WriteLine(($object | ConvertTo-Json -Compress -Depth 4)); $IJWAOut.Flush() }

Add-Type -Namespace IJWA -Name Win -MemberDefinition @'
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
/// made topmost itself: a browser put back under iJWA's light (topmost, over the whole screen) stayed over every
/// window after (the test PC, 2026-10-12). Under a topmost window an ordinary one was the top of the ordinary ones,
/// so it goes back there instead.
public static void PutUnder(IntPtr h, IntPtr above) {
  bool aboveTopmost = (GetWindowLong(above, -20) & 0x8) != 0, topmost = (GetWindowLong(h, -20) & 0x8) != 0;
  SetWindowPos(h, aboveTopmost && !topmost ? IntPtr.Zero : above, 0, 0, 0, 0, 0x0013);
}
[DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, IntPtr extra);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
[DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref PLACEMENT p);
[DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr h, ref PLACEMENT p);
[StructLayout(LayoutKind.Sequential)] public struct PLACEMENT { public int length; public int flags; public int showCmd; public int minX; public int minY; public int maxX; public int maxY; public int left; public int top; public int right; public int bottom; }
[DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUT info);
[DllImport("kernel32.dll")] public static extern uint GetTickCount();
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
[StructLayout(LayoutKind.Sequential)] public struct CURSOR { public int X; public int Y; }
[DllImport("user32.dll")] public static extern bool GetCursorPos(out CURSOR p);
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(CURSOR p);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
public static uint UnderPointer() {
  CURSOR p; if (!GetCursorPos(out p)) return 0;
  IntPtr w = GetAncestor(WindowFromPoint(p), 2);
  uint pid = 0; if (w != IntPtr.Zero) GetWindowThreadProcessId(w, out pid);
  return pid;
}
[StructLayout(LayoutKind.Sequential)] public struct LASTINPUT { public uint cbSize; public uint dwTime; }
public static uint LastInput() { LASTINPUT i = new LASTINPUT(); i.cbSize = (uint)Marshal.SizeOf(i); GetLastInputInfo(ref i); return i.dwTime; }
'@

# The keys back to the window the user was in: a key press first (F24, which nothing uses), as Windows lets an app hand
# the foreground on only right after input; with no window in front, the desktop — never Spotify keeping them.
function GiveBack($front) {
  if (-not $front -or $front -eq [IntPtr]::Zero) { $front = [IJWA.Win]::GetShellWindow() }
  if ($front -eq [IntPtr]::Zero) { return }
  [IJWA.Win]::keybd_event(0x87, 0, 0, [IntPtr]::Zero); [IJWA.Win]::keybd_event(0x87, 0, 2, [IntPtr]::Zero)
  $null = [IJWA.Win]::SetForegroundWindow($front)
  # That press is Windows' latest input too: never taken for the user's own (it left Spotify shown as if they had
  # opened it, the test machine, 2026-10-10).
  $script:inputBefore = [IJWA.Win]::LastInput()
}

# A press of the user's own that brings a window forward: a mouse button (its taskbar button), Alt (Alt-Tab), the Windows
# key — never the pointer only moving, which Windows' last-input time counts too: a friend moving his mouse while a song
# started had Spotify taken for his and left in front (2026-10-10). Looked at every turn of the waits below.
# A click on iJWA itself — the player, its cards, its search — is no one opening Spotify: its windows are iJWA's
# own process's, the one this helper was started from.
$script:pressedAt = 0
$script:iJWAPid = try { [uint32](Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId } catch { [uint32]0 }
function Watch {
  foreach ($key in 0x12, 0x5B, 0x5C) {
    if ([IJWA.Win]::GetAsyncKeyState($key) -band 0x8000) { $script:pressedAt = [IJWA.Win]::GetTickCount(); return }
  }
  foreach ($key in 0x01, 0x02, 0x04) {
    if (-not ([IJWA.Win]::GetAsyncKeyState($key) -band 0x8000)) { continue }
    if ([IJWA.Win]::UnderPointer() -ne $script:iJWAPid) { $script:pressedAt = [IJWA.Win]::GetTickCount() }
    return
  }
}

# Spotify brought to the front by the user themselves — its taskbar button clicked, Alt-Tab — while iJWA had it play:
# theirs from then on, shown and left open (Mac, 2026-10-10: Spotify clicked open went straight back out of sight). The
# user pressed within a moment of it coming forward, after the play began.
function UserOpened($handle) {
  Watch
  if (-not $handle -or [IJWA.Win]::GetForegroundWindow() -ne $handle) { return $false }
  return ($script:pressedAt -ne 0) -and (([IJWA.Win]::GetTickCount() - $script:pressedAt) -lt 1500)
}

# "i am > i was (Deluxe)" and "i am > i was" are one album; "ISSA" and "Issa Album" are not.
function Plain([string]$text) {
  $t = $text.ToLowerInvariant() -replace '\s*[\(\[].*?[\)\]]', '' -replace ' - (single|ep)$', ''
  return ($t -replace '[^\p{L}\p{N}]+', ' ').Trim()
}

function SpotifyWindow {
  Get-Process Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
}

# Spotify has to be open, not minimized, for its contents to be read; it is made see-through meanwhile, without its
# opening and minimizing animations, so nothing seems to happen but the music starting.
function SeeThrough($handle, $on, [byte]$alpha = 0) {
  if (-not $handle -or $handle -eq [IntPtr]::Zero) { return }
  $style = [IJWA.Win]::GetWindowLong($handle, -20)
  $off = [int]$on
  $null = [IJWA.Win]::DwmSetWindowAttribute($handle, 3, [ref]$off, 4)
  # Layered at no opacity and passing clicks through (WS_EX_TRANSPARENT): there for the app, neither seen nor in the way.
  if ($on) { $null = [IJWA.Win]::SetWindowLong($handle, -20, $style -bor 0x80020); $null = [IJWA.Win]::SetLayeredWindowAttributes($handle, 0, $alpha, 2) }
  else { $null = [IJWA.Win]::SetLayeredWindowAttributes($handle, 0, 255, 2); $null = [IJWA.Win]::SetWindowLong($handle, -20, $style -band (-bnot 0x80020)) }
}

# What each look into the window brings back with the elements: their name, kind, whether they can be pressed, and
# a link's address (its value).
$cache = New-Object System.Windows.Automation.CacheRequest
foreach ($p in @($A::NameProperty, $A::ControlTypeProperty, $A::IsInvokePatternAvailableProperty, $ValueProperty, $A::ClassNameProperty)) { $cache.Add($p) }
function Scan($element, $condition) {
  $cache.Push()
  try { return @($element.FindAll($Scope::Descendants, $condition)) } finally { $cache.Pop() }
}
function NameOf($e) { try { return [string]$e.Cached.Name } catch { return '' } }
function ClassOf($e) { try { return [string]$e.Cached.ClassName } catch { return '' } }
function KindOf($e) { try { return $e.Cached.ControlType } catch { return $null } }
function AddressOf($e) { try { $v = $e.GetCachedPropertyValue($ValueProperty); if ($v -is [string]) { return $v } } catch { }; return '' }
function Pressable($e) { try { return [bool]$e.GetCachedPropertyValue($A::IsInvokePatternAvailableProperty) } catch { return $false } }

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$linkCondition = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $Types::Hyperlink)
$buttonCondition = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $Types::Button)
# Spotify's search field is a combo box ("What do you want to play?").
$comboCondition = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $Types::ComboBox)

# ---- the input: read without blocking, so a play still looking can see a newer one come in ----
$stdin = if ($IJWAIn) { $IJWAIn } else { New-Object System.IO.StreamReader([Console]::OpenStandardInput()) }
$script:pending = $stdin.ReadLineAsync()
$script:waiting = New-Object System.Collections.Queue
function Arrived {
  if ($script:pending.IsCompleted) {
    $text = $script:pending.Result
    if ($null -eq $text) { exit }   # iJWA is gone
    $script:pending = $stdin.ReadLineAsync()
    if ($text.Trim()) { $script:waiting.Enqueue($text) }
  }
}
function Superseded {
  Arrived
  foreach ($text in $script:waiting) { if ($text -match '"do"\s*:\s*"play"') { return $true } }
  return $false
}

# ---- playing ----

# A play given way to leaves Spotify as it is (see-through, maybe forward): the next one puts it back as it was.
$script:carry = $null

function Play($c) {
  $Title = [string]$c.title; $Artist = [string]$c.artist; $Id = [string]$c.id; $Context = [string]$c.context
  $Kind = if ($c.kind) { [string]$c.kind } else { 'track' }
  $want = Plain $Title
  if ($script:carry) { $foreground = $script:carry.foreground; $state = $script:carry.state; $above = $script:carry.above; $script:carry = $null }
  else {
    $foreground = [IJWA.Win]::GetForegroundWindow()
    $before = SpotifyWindow
    $above = if ($before) { [IJWA.Win]::GetWindow($before.MainWindowHandle, 3) } else { [IntPtr]::Zero }
    $state = if (-not $before) { 'hidden' } elseif ([IJWA.Win]::IsIconic($before.MainWindowHandle)) { 'minimized' } elseif ($foreground -eq $before.MainWindowHandle) { 'front' } else { 'behind' }
    # A minimized Spotify can still be Windows' foreground (nothing else took it): the keys then go to the desktop.
    if ($state -eq 'minimized' -and $foreground -eq $before.MainWindowHandle) { $foreground = [IJWA.Win]::GetShellWindow() }
    if ($state -ne 'front' -and $before) { SeeThrough $before.MainWindowHandle $true }
  }

  $lead = Plain (($Artist -split ',| & | feat\. | ft\. | x | with | ve ')[0])
  $query = if ($Artist) { "$Artist $Title" } else { $Title }
  $script:inputBefore = [IJWA.Win]::LastInput()
  # The click that picked the song is over by now: only presses from here on are taken for the user opening Spotify.
  $script:pressedAt = 0
  $theirs = $false
  # Not running: opened first, out of sight, and waited for until its window is there and has drawn — handed an address
  # while starting up, it let the word go by and nothing played (Mac, 2026-10-10).
  if (-not (Get-Process Spotify -ErrorAction SilentlyContinue)) {
    Start-Process 'spotify:'
    $ready = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $ready) {
      Start-Sleep -Milliseconds 200
      $w = SpotifyWindow
      if (-not $w) { continue }
      SeeThrough $w.MainWindowHandle $true
      $root = $A::FromHandle($w.MainWindowHandle)
      if ($root -and $root.FindFirst($Scope::Descendants, $buttonCondition)) { break }
    }
    Start-Sleep -Milliseconds 800
  }
  # In a list (a playlist, the songs liked): its page, the song's row pressed there, so the list goes on after it.
  if ($Id -and $Context) { Start-Process $Context }
  elseif ($Id) { Start-Process "spotify:track:$Id" }
  # Spaces must be encoded: Spotify keeps only the first word of a search address otherwise.
  else { Start-Process ("spotify:search:" + [Uri]::EscapeDataString($query)) }
  $handedAt = Get-Date

  # Spotify comes forward when handed an address: the keys go straight back to the window the user was in.
  if ($state -ne 'front') {
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Milliseconds 50
      Watch
      $w = SpotifyWindow
      if ($w -and $state -eq 'hidden') { SeeThrough $w.MainWindowHandle $true }
      if ($w -and [IJWA.Win]::GetForegroundWindow() -eq $w.MainWindowHandle) { break }
    }
    if ($w -and (UserOpened $w.MainWindowHandle)) { $theirs = $true; SeeThrough $w.MainWindowHandle $false }
    else { GiveBack $foreground }
  }

  $button = $null; $foundId = $Id; $foundName = $Title
  $searched = $false; $gaveWay = $false; $playing = $false
  $deadline = (Get-Date).AddSeconds(12)
  $pause = 350
  while ((Get-Date) -lt $deadline -and -not $button) {
    if (Superseded) { $gaveWay = $true; break }
    Start-Sleep -Milliseconds $pause
    $pause = 250
    $window = SpotifyWindow
    if (-not $window) { continue }
    # A window that came up late stays out of sight too — unless the user opened it themselves.
    if ($state -ne 'front' -and -not $theirs) {
      if (UserOpened $window.MainWindowHandle) { $theirs = $true; SeeThrough $window.MainWindowHandle $false }
      else { SeeThrough $window.MainWindowHandle $true; if ([IJWA.Win]::GetForegroundWindow() -eq $window.MainWindowHandle) { GiveBack $foreground } }
    }
    $root = $A::FromHandle($window.MainWindowHandle)

    # Handed a song with nothing playing, Spotify plays it by itself: its window is named after the song playing
    # ("Lil Tecca - BAD TIME"; "Spotify Free" when nothing plays). Pressed again, its row would pause it.
    if ($Id) {
      $named = Plain $window.MainWindowTitle
      if ($want -and $named.Contains($want) -and (-not $lead -or $named.Contains($lead))) { $playing = $true; break }
    }

    if ($Id) {
      # The song's row on its album page: the first button in a row that names the song and can be pressed is its
      # Play button (the others come after it: Add to Liked Songs, More options).
      foreach ($b in (Scan $root $buttonCondition)) {
        if (-not (Pressable $b) -or -not (Plain (NameOf $b)).Contains($want)) { continue }
        $node = $b; $inRow = $false
        for ($up = 0; $up -lt 3 -and -not $inRow; $up++) {
          $node = $walker.GetParent($node)
          if (-not $node) { break }
          if ($node.Current.ControlType -eq $Types::DataItem) { $inRow = $true }
        }
        if ($inRow) { $button = $b; break }
      }
      continue
    }

    # Results on screen may be an earlier search's: only once the search field holds this query are they ours.
    if (-not $searched) {
      # It shows the words joined by '+', as Spotify keeps them.
      foreach ($combo in (Scan $root $comboCondition)) {
        if (((AddressOf $combo) -replace '\+', ' ' -replace '\s+', ' ').Trim().ToLowerInvariant() -eq ($query -replace '\s+', ' ').Trim().ToLowerInvariant()) { $searched = $true }
      }
      if (-not $searched) { continue }
      Start-Sleep -Milliseconds 700
    }
    # What the results showed, said when nothing matched: why a search found nothing is otherwise unknown.
    $seen = @()
    foreach ($link in (Scan $root $linkCondition)) {
      if ((AddressOf $link) -notmatch "/$Kind/([A-Za-z0-9]{22})") { continue }
      # (Not $id: PowerShell's names ignore case, and that is the command's $Id.)
      $linkId = $Matches[1]
      $seen += "'$(NameOf $link)'"
      if ((Plain (NameOf $link)) -ne $want) { continue }
      # The card or row the link belongs to: the nearest group above it that holds a button.
      $card = $link
      for ($up = 0; $up -lt 5; $up++) {
        $card = $walker.GetParent($card)
        if (-not $card -or $card.FindFirst($Scope::Descendants, $buttonCondition)) { break }
      }
      if (-not $card) { continue }
      $inside = Scan $card ([System.Windows.Automation.Condition]::TrueCondition)
      # By the right artist, when the card names one.
      $artists = @($inside | Where-Object { (KindOf $_) -eq $Types::Hyperlink -and (AddressOf $_) -match '/artist/' } | ForEach-Object { Plain (NameOf $_) })
      if ($lead -and $artists.Count -gt 0 -and -not ($artists -contains $lead)) { $seen[-1] += " by $($artists -join ', ')"; continue }
      # Its Play button. Spotify says "Play" in its language: alone on the top result's big green button ("Çal"), with
      # the name after it in a row ("Çal: İmza", "Play İmza by Sıla"). The card's other buttons, shown under the
      # pointer, put the name first ("İmza içeriğini Kitaplığın'a kaydeder") or leave it out ("Save to Your Library"):
      # taken for Play because it named the album, a friend's Spotify saved İmza to his library and played nothing
      # (2026-10-10).
      $buttons = @($inside | Where-Object { (KindOf $_) -eq $Types::Button -and (Pressable $_) })
      $button = $buttons | Where-Object { (ClassOf $_) -match 'button-primary' } | Select-Object -First 1
      if (-not $button) {
        $button = $buttons | Where-Object { $named = Plain (NameOf $_); $named.Contains(" $want") -and -not $named.StartsWith($want) } | Select-Object -First 1
      }
      if (-not $button -and $buttons.Count -eq 1 -and -not (Plain (NameOf $buttons[0])).Contains($want)) { $button = $buttons[0] }
      if ($button) { $foundId = $linkId; $foundName = NameOf $link; break }
      $seen[-1] += " with $($buttons.Count) buttons"
    }
  }

  if ($gaveWay) {
    $script:carry = @{ foreground = $foreground; state = $state; above = $above }
    return @{ ok = $false; error = 'superseded' }
  }
  $answer = $null
  if ($playing) { $answer = @{ ok = $true; id = $foundId; name = $foundName; pressed = 'playing already' } }
  elseif (-not $button) {
    $why = if ($Id) { 'song not shown' } elseif ($searched) { "not found: wanted '$want' by '$lead', saw $(($seen | Select-Object -First 6) -join '; ')" } else { 'search did not open' }
    $answer = @{ ok = $false; error = $why }
  }
  else {
    try {
      $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      $answer = @{ ok = $true; id = $foundId; name = $foundName; pressed = (NameOf $button) }
    } catch { $answer = @{ ok = $false; id = $foundId; error = "press failed: $_" } }
  }

  # Handed an address, Spotify brings its window up by itself a moment later: after a song it played at once, once
  # iJWA had put it back (1.5 s, the test machine, 2026-10-10). Kept out of sight till then, the keys given back.
  if ($state -ne 'front' -and -not $theirs) {
    while (((Get-Date) - $handedAt).TotalMilliseconds -lt 3500) {
      Start-Sleep -Milliseconds 100
      $w = SpotifyWindow
      if (-not $w) { continue }
      if (UserOpened $w.MainWindowHandle) { $theirs = $true; break }
      SeeThrough $w.MainWindowHandle $true
      if ([IJWA.Win]::GetForegroundWindow() -eq $w.MainWindowHandle) { GiveBack $foreground }
    }
  }

  # However it went, Spotify goes back as it was: minimized, in the tray, or behind; and solid again — unless the user
  # opened it meanwhile: then it stays, theirs.
  Start-Sleep -Milliseconds 250
  $after = SpotifyWindow
  if ($after -and -not $theirs -and (UserOpened $after.MainWindowHandle)) { $theirs = $true }
  if ($after -and $theirs) { SeeThrough $after.MainWindowHandle $false }
  elseif ($after -and $state -ne 'front') {
    $h = $after.MainWindowHandle
    switch ($state) {
      'minimized' { $null = [IJWA.Win]::ShowWindow($h, 7) }   # SW_SHOWMINNOACTIVE
      'hidden'    { $null = [IJWA.Win]::ShowWindow($h, 0) }   # SW_HIDE
      'behind'    {
        # Under the window it was under again, without taking the keys (never at the very bottom: that is under the
        # desktop, where it would be lost).
        if ($above -and $above -ne [IntPtr]::Zero) { [IJWA.Win]::PutUnder($h, $above) }
      }
    }
    # The keyboard never stays with a Spotify out of sight: the next key (Space, say) would go to it.
    if ([IJWA.Win]::GetForegroundWindow() -eq $h) { GiveBack $foreground }
    Start-Sleep -Milliseconds 150
    SeeThrough $h $false
  }
  return $answer
}

# ---- an app's own volume ----

# The volume the mixer shows for an app (Spotify, a browser): Core Audio's audio sessions, each process's own.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class IJWADeviceEnumerator {}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IIJWADeviceEnumerator { int NotImpl1(); [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IIJWADevice device); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IIJWADevice { [PreserveSig] int Activate(ref Guid iid, int context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object result); }
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IIJWASessionManager { int NotImpl1(); int NotImpl2(); [PreserveSig] int GetSessionEnumerator(out IIJWASessions sessions); }
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IIJWASessions { [PreserveSig] int GetCount(out int count); [PreserveSig] int GetSession(int index, out IIJWASession session); }
[Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IIJWASession { int N0(); int N1(); int N2(); int N3(); int N4(); int N5(); int N6(); int N7(); int N8(); int N9(); int N10(); [PreserveSig] int GetProcessId(out int pid); }
[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IIJWASimpleVolume { [PreserveSig] int SetMasterVolume(float level, ref Guid context); [PreserveSig] int GetMasterVolume(out float level); }
public static class IJWAVolume {
    static List<IIJWASimpleVolume> Of(string name) {
        var found = new List<IIJWASimpleVolume>();
        var enumerator = (IIJWADeviceEnumerator)new IJWADeviceEnumerator();
        IIJWADevice device;
        if (enumerator.GetDefaultAudioEndpoint(0, 1, out device) != 0) return found;
        var iid = typeof(IIJWASessionManager).GUID;
        object manager;
        if (device.Activate(ref iid, 23, IntPtr.Zero, out manager) != 0) return found;
        IIJWASessions sessions;
        ((IIJWASessionManager)manager).GetSessionEnumerator(out sessions);
        int count; sessions.GetCount(out count);
        for (int i = 0; i < count; i++) {
            IIJWASession session; sessions.GetSession(i, out session);
            int pid; session.GetProcessId(out pid);
            string process = "";
            try { process = Process.GetProcessById(pid).ProcessName; } catch { continue; }
            if (string.Equals(process, name, StringComparison.OrdinalIgnoreCase)) found.Add((IIJWASimpleVolume)session);
        }
        return found;
    }
    public static float Get(string name) {
        foreach (var volume in Of(name)) { float level; if (volume.GetMasterVolume(out level) == 0) return level; }
        return -1;
    }
    public static bool Set(string name, float level) {
        var guid = Guid.Empty; bool any = false;
        foreach (var volume in Of(name)) { volume.SetMasterVolume(Math.Max(0, Math.Min(1, level)), ref guid); any = true; }
        return any;
    }
}
'@

function Volume($c) {
  # The app as Windows' media controls name it ("Spotify.exe", "Chrome", "MSEdge"): its process's name.
  $name = ([string]$c.app) -replace '\.exe$', '' -replace '^.*!', ''
  if ($name -match '^(chrome|msedge|firefox|brave|opera|vivaldi|spotify)$' -eq $false) {
    foreach ($known in @('Spotify', 'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi')) { if ($name -like "*$known*") { $name = $known } }
  }
  if ($null -ne $c.value) { return @{ ok = [IJWAVolume]::Set($name, [float]$c.value) } }
  $level = [IJWAVolume]::Get($name)
  return @{ volume = $(if ($level -ge 0) { [math]::Round($level, 3) } else { $null }) }
}

# ---- Apple Music ----
# Windows' Apple Music app takes no addresses of songs, but its own search, pages and menus can be worked as a screen
# reader works them (it names everything; its control IDs don't change with the language): the song found by its own
# search, its album's page opened, and "Play “Song”" chosen from its row's ••• menu; an album or an artist played by
# its page's Play. The app is woken by its own address (music:) — Windows lets it take the keys then, for the search's
# Enter — see-through all the while, and put back as it was after.
$AppleApp = 'shell:AppsFolder\AppleInc.AppleMusicWin_nzyj5cx40ttqa!App'

# Its menus, its search's suggestions and the like open in windows of their own: while it is worked, each window it
# shows is made see-through the moment Windows says it shows (a hook on its process, on a thread of its own), and put
# back after.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public static class IJWAUnseen {
    delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc proc, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int index, int value);
    [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attribute, ref int value, int size);
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr w; public IntPtr l; public uint time; public int x; public int y; }
    static Thread worker; static uint workerId; static WinEventProc held;
    static readonly List<IntPtr> hidden = new List<IntPtr>();
    public static void Start(uint pid) {
        Stop();
        var ready = new ManualResetEvent(false);
        worker = new Thread(() => {
            workerId = GetCurrentThreadId();
            held = (hook, ev, hwnd, idObject, idChild, thread, time) => {
                if (idObject != 0 || hwnd == IntPtr.Zero || GetAncestor(hwnd, 2) != hwnd) return;   // whole top-level windows only
                Hide(hwnd);
            };
            IntPtr hookHandle = SetWinEventHook(0x8002, 0x8002, IntPtr.Zero, held, pid, 0, 0);   // EVENT_OBJECT_SHOW, out of context
            ready.Set();
            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
            UnhookWinEvent(hookHandle);
        });
        worker.IsBackground = true;
        worker.Start();
        ready.WaitOne(2000);
    }
    public static void Hide(IntPtr h) {
        lock (hidden) { if (hidden.Contains(h)) return; hidden.Add(h); }
        int on = 1; DwmSetWindowAttribute(h, 3, ref on, 4);
        SetWindowLong(h, -20, GetWindowLong(h, -20) | 0x80020);
        SetLayeredWindowAttributes(h, 0, 0, 2);
    }
    public static void Stop() {
        if (worker != null) { PostThreadMessage(workerId, 0x0012, IntPtr.Zero, IntPtr.Zero); worker.Join(1000); worker = null; }
        List<IntPtr> list; lock (hidden) { list = new List<IntPtr>(hidden); hidden.Clear(); }
        foreach (var h in list) {
            SetLayeredWindowAttributes(h, 0, 255, 2);
            SetWindowLong(h, -20, GetWindowLong(h, -20) & ~0x80020);
            int off = 0; DwmSetWindowAttribute(h, 3, ref off, 4);
        }
    }
}
'@

function AppleWindow {
  $p = Get-Process AppleMusic -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $p) { return $null }
  $condition = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $p.Id)
  foreach ($w in $A::RootElement.FindAll($Scope::Children, $condition)) { if ($w.Current.ClassName -eq 'WinUIDesktopWin32WindowClass') { return $w } }
  return $null
}
function ById($root, [string]$id) { return $root.FindFirst($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty, $id))) }
# Whether the keyboard is at `$element` or inside it.
function KeysAt($element) {
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
function ByType($root, $type) { return $root.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $type))) }
function Until([double]$seconds, [scriptblock]$test) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) { $r = & $test; if ($r) { return $r }; Start-Sleep -Milliseconds 150 }
  return $null
}
function Press($e) { try { $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch { return $false } }
function Texts($e) { return @(ByType $e $Types::Text | ForEach-Object { [string]$_.Current.Name }) }
# The page's own list: its rows (a track list), or its sections (search results), the ones off the screen too.
function PageItems($win) {
  $content = $win.FindFirst($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'LandmarkTarget')))
  $lists = @()
  foreach ($l in (Until 3 { @(ByType $win $Types::List) })) { $lists += $l }
  return $lists
}
function RowsOf($list) {
  $rows = @()
  try {
    $container = $list.GetCurrentPattern([System.Windows.Automation.ItemContainerPattern]::Pattern)
    $item = $null; $n = 0
    do { $item = $container.FindItemByProperty($item, $null, $null); $n++; if ($item) { $rows += $item } } while ($item -and $n -lt 120)
  } catch { }
  return $rows
}

function Apple($c) {
  $Title = [string]$c.title; $Artist = [string]$c.artist; $Kind = if ($c.kind) { [string]$c.kind } else { 'track' }
  $want = Plain $Title; $lead = Plain (($Artist -split ',| & | feat\. | ft\. | x | with ')[0])
  $foreground = [IJWA.Win]::GetForegroundWindow()
  $win = AppleWindow
  $state = 'behind'
  if (-not $win) {
    Start-Process explorer.exe $AppleApp
    # Every window it shows made see-through the moment it shows: found only later, its window stood on the screen
    # while it started (two seconds, the test machine, 2026-10-10).
    $until = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $until) {
      $process = Get-Process AppleMusic -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($process) { [IJWAUnseen]::Start([uint32]$process.Id); break }
      Start-Sleep -Milliseconds 30
    }
    $win = Until 20 { AppleWindow }
    if (-not $win) { return @{ ok = $false; error = 'Apple Music did not open' } }
    $state = 'opened'
    Start-Sleep -Seconds 2
  }
  $h = [IntPtr]$win.Current.NativeWindowHandle
  if ($state -ne 'opened') { $state = if ([IJWA.Win]::IsIconic($h)) { 'minimized' } elseif ($foreground -eq $h) { 'front' } else { 'behind' } }
  # Unseen while it is worked: in its place, but see-through and letting clicks pass, its animations off; a minimized
  # window is shown first (WinUI lays nothing out in a minimized one). Put back as it was after: minimized again, or
  # under the window it was under.
  $above = [IJWA.Win]::GetWindow($h, 3)
  if ($state -ne 'front') {
    # (Started afresh, the hook would first show again what it hid.)
    if ($state -ne 'opened') { [IJWAUnseen]::Start([uint32]$win.Current.ProcessId) }
    SeeThrough $h $true
    if ($state -eq 'minimized' -or $state -eq 'opened') { $null = [IJWA.Win]::ShowWindow($h, 4) }   # SW_SHOWNOACTIVATE
    Start-Sleep -Milliseconds 350
  }
  $answer = $null
  try {
    # The keys its, for the search's Enter: a background process may hand them over just after a key was pressed — F24,
    # which no app answers (Alt would show the app's key tips); failing that, woken by its own address it takes them.
    if ($state -ne 'front') {
      [IJWA.Win]::keybd_event(0x87, 0, 0, [IntPtr]::Zero); [IJWA.Win]::keybd_event(0x87, 0, 2, [IntPtr]::Zero)
      $null = [IJWA.Win]::SetForegroundWindow($h)
      if (-not (Until 0.6 { [IJWA.Win]::GetForegroundWindow() -eq $h })) { Start-Process 'music:'; $null = Until 3 { [IJWA.Win]::GetForegroundWindow() -eq $h } }
    }
    $transport = ById $win 'TransportControl_PlayPauseStop'
    $before = if ($transport) { [string]$transport.Current.Name } else { '' }

    # Its own search: the words in its box, Enter.
    $search = ById $win 'Search_Button'
    if (-not $search -or -not (Press $search)) { return @{ ok = $false; error = 'no search' } }
    $box = Until 4 { (ByType $win $Types::Edit) | Select-Object -First 1 }
    if (-not $box) { return @{ ok = $false; error = 'no search box' } }
    # The whole catalog searched, not the library: its "Apple Music" switch on.
    $catalog = Until 3 { ById $win 'SearchAppleMusic' }
    if ($catalog) {
      try {
        $toggle = $catalog.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        if ($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) { $toggle.Toggle(); Start-Sleep -Milliseconds 300 }
      } catch { $null = Press $catalog }
    }
    $query = if ($Kind -eq 'artist') { $Title } else { "$Title $Artist".Trim() }
    $box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($query)
    $box.SetFocus(); Start-Sleep -Milliseconds 150
    # Enter only while the search box has the keyboard: pressed elsewhere — Search, the desktop — it opens what is
    # chosen there (web-agent.ps1's FocusIn, 2026-10-09).
    if (-not (KeysAt $box)) { return @{ ok = $false; error = 'search box not in front' } }
    [IJWA.Win]::keybd_event(0x0D, 0, 0, [IntPtr]::Zero); [IJWA.Win]::keybd_event(0x0D, 0, 2, [IntPtr]::Zero)
    # The results are this search's once the page says so: its line names the words searched.
    $status = Until 10 { $s = ById $win 'SearchPageStatus'; if ($s -and ([string]$s.Current.Name).ToLowerInvariant().Contains($query.ToLowerInvariant())) { $s } }
    if (-not $status) { return @{ ok = $false; error = 'search did not answer' } }
    Start-Sleep -Milliseconds 700

    # The top results, each "Title" over "Kind · Artist": the one of the name asked, by the artist asked. They come a
    # moment after the page says what it shows.
    $cards = @(Until 8 { $found = @(ByType $win $Types::ListItem | Where-Object { $_.Current.ClassName -eq 'GridViewItem' }); if ($found.Count) { , $found } } | Where-Object { $_ })
    # Its name exactly first ("Lucid Dreams", not "Lucid Dreams (Live)" before it); then the same without brackets.
    $exact = @(); $near = @()
    foreach ($card in $cards) {
      $t = @(Texts $card)
      if ($t.Count -lt 1) { continue }
      $by = if ($t.Count -gt 1) { Plain $t[1] } else { '' }
      if (-not ($Kind -eq 'artist' -or -not $lead -or $by.Contains($lead))) { continue }
      if ($t[0].Trim() -ieq $Title.Trim()) { $exact += $card } elseif ((Plain $t[0]) -eq $want) { $near += $card }
    }
    $match = @($exact + $near | Select-Object -First 4)
    if (-not $match.Count) {
      $seen = @(ByType $win $Types::ListItem | Select-Object -First 8 | ForEach-Object { "$($_.Current.Name) <$($_.Current.ClassName)>" }) -join ' | '
      # Its search can stick, showing no results for anything until the app starts again ("Lucid Dreams" too, the
      # test machine, 2026-10-10): then it's started again, once.
      return @{ ok = $false; error = 'not found'; cards = $cards.Count; first = "status: $($status.Current.Name); items: $seen"; stuck = ($cards.Count -eq 0) }
    }

    foreach ($card in $match) {
      $null = Press $card
      Start-Sleep -Milliseconds 900
      if ($Kind -eq 'track') {
        # The song's album page: its row, its ••• menu, "Play “Song”".
        # The row whose title is the song's exactly ("Lucid Dreams", not "Lucid Dreams (Remix)" above it); failing that,
        # the first whose title is it without its brackets.
        $row = $null; $near = $null
        foreach ($list in (PageItems $win)) {
          foreach ($r in (RowsOf $list)) {
            if ($r.Current.ClassName -eq 'GridViewItem') { continue }
            try { $r.GetCurrentPattern([System.Windows.Automation.VirtualizedItemPattern]::Pattern).Realize() } catch { }
            $texts = @(Texts $r)
            if ($texts | Where-Object { $_.Trim() -ieq $Title.Trim() }) { $row = $r; break }
            if (-not $near -and ($texts | Where-Object { (Plain $_) -eq $want })) { $near = $r }
          }
          if ($row) { break }
        }
        if (-not $row) { $row = $near }
        if (-not $row) { continue }
        $more = $row.FindFirst($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $Types::Button)))
        if (-not $more -or -not (Press $more)) { continue }
        $quoted = Until 3 { ByType $win $Types::MenuItem | Where-Object { $n = [string]$_.Current.Name; $n -match ('[“"«„]' + [regex]::Escape($Title) + '[”"»“]') } | Select-Object -First 1 }
        # The row's own title in its quotes when the exact one wasn't on the page.
        if (-not $quoted) { $rowTitle = @(Texts $row) | Where-Object { (Plain $_) -eq $want } | Select-Object -First 1
          if ($rowTitle) { $quoted = ByType $win $Types::MenuItem | Where-Object { ([string]$_.Current.Name).Contains($rowTitle) } | Select-Object -First 1 } }
        if ($quoted -and (Press $quoted)) { $answer = @{ ok = $true; played = [string]$quoted.Current.Name }; break }
      } else {
        # An album's or an artist's page: its own Play.
        $play = Until 4 { ById $win 'PlayButtonElement' }
        if (-not $play) { $play = ByType $win $Types::Button | Where-Object { $_.Current.AutomationId -match 'Play' } | Select-Object -First 1 }
        if ($play -and (Press $play)) { $answer = @{ ok = $true; played = $Kind }; break }
      }
      # Not this one (a video's page, say): back to the results for the next.
      $back = ById $win 'NavigationViewBackButton'
      if ($back) { $null = Press $back; Start-Sleep -Milliseconds 700 }
    }
    if (-not $answer) { $answer = @{ ok = $false; error = 'could not play it' } }
    else {
      $playing = Until 4 { $t = ById $win 'TransportControl_PlayPauseStop'; if ($t -and [string]$t.Current.Name -ne $before) { $true } }
      $answer.started = [bool]$playing
    }
  } finally {
    # The keys go back to the window the user was in, and Apple Music to where it was — then it shows again.
    if ($state -ne 'front') {
      if ($foreground -ne [IntPtr]::Zero) { [IJWA.Win]::keybd_event(0x87, 0, 0, [IntPtr]::Zero); [IJWA.Win]::keybd_event(0x87, 0, 2, [IntPtr]::Zero); $null = [IJWA.Win]::SetForegroundWindow($foreground) }
      if ($state -eq 'minimized' -or $state -eq 'opened') { $null = [IJWA.Win]::ShowWindow($h, 7) }   # SW_SHOWMINNOACTIVE
      elseif ($above -ne [IntPtr]::Zero) { [IJWA.Win]::PutUnder($h, $above) }
      Start-Sleep -Milliseconds 250
      [IJWAUnseen]::Stop()
      SeeThrough $h $false
    }
  }
  return $answer
}

# Apple Music lets Windows' media controls start and stop it, not move it within a song (IsPlaybackPositionEnabled is
# false): its own scrubber (LCDScrubber, in seconds) is moved instead. A minimized window lays nothing out, so it is shown
# see-through for the moment and minimized again.
function AppleSeek($c) {
  $win = AppleWindow
  if (-not $win) { return @{ ok = $false; error = 'Apple Music is not open' } }
  $h = [IntPtr]$win.Current.NativeWindowHandle
  $minimized = [IJWA.Win]::IsIconic($h)
  if ($minimized) { SeeThrough $h $true; $null = [IJWA.Win]::ShowWindow($h, 4); Start-Sleep -Milliseconds 350 }   # SW_SHOWNOACTIVATE
  try {
    $scrubber = Until 2 { ById $win 'LCDScrubber' }
    if (-not $scrubber) { return @{ ok = $false; error = 'no scrubber' } }
    $range = $scrubber.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
    $range.SetValue([math]::Max($range.Current.Minimum, [math]::Min([double]$c.seconds, $range.Current.Maximum)))
    return @{ ok = $true; at = $range.Current.Value }
  } finally {
    if ($minimized) { $null = [IJWA.Win]::ShowWindow($h, 7); Start-Sleep -Milliseconds 250; SeeThrough $h $false }   # SW_SHOWMINNOACTIVE
  }
}

# Apple Music's repeat, by its own button: Windows' media controls can't set it (IsRepeatEnabled false). The button names
# its state in the app's language — "Repeat", "Repeat All", "Repeat One"; "Yineleme", "Tümünü Yinele", "Birini Yinele"
# (2026-10-10) — and goes off, all, one, round again. Its three names are learned once by pressing it round — off the
# plainest, all the one after it — then it is pressed until it names the one asked. Shown unseen while minimized.
$script:appleRepeat = $null
function AppleRepeat($c) {
  $win = AppleWindow
  if (-not $win) { return @{ ok = $false; error = 'Apple Music is not open' } }
  $h = [IntPtr]$win.Current.NativeWindowHandle
  $minimized = [IJWA.Win]::IsIconic($h)
  if ($minimized) { SeeThrough $h $true; $null = [IJWA.Win]::ShowWindow($h, 4); Start-Sleep -Milliseconds 350 }   # SW_SHOWNOACTIVATE
  try {
    if (-not (Until 2 { ById $win 'RepeatButton' })) { return @{ ok = $false; error = 'no repeat button' } }
    $name = { [string](ById $win 'RepeatButton').Current.Name }
    $press = { $was = & $name; $null = Press (ById $win 'RepeatButton'); $null = Until 1.5 { (& $name) -ne $was } }
    if (-not $script:appleRepeat -or -not $script:appleRepeat.ContainsKey((& $name))) {
      $seen = @(& $name)
      for ($i = 0; $i -lt 3; $i++) { & $press; $now = & $name; if ($now -eq $seen[0]) { break }; $seen += $now }
      if ($seen.Count -ne 3) { return @{ ok = $false; error = "repeat names: $($seen -join ' / ')" } }
      $off = $seen | Where-Object { $_ -match '\boff\b|kapal' } | Select-Object -First 1
      if (-not $off) { $off = $seen | Sort-Object Length | Select-Object -First 1 }
      $at = [array]::IndexOf($seen, $off)
      $script:appleRepeat = @{ $off = 'off'; $seen[($at + 1) % 3] = 'all'; $seen[($at + 2) % 3] = 'one' }
    }
    for ($i = 0; $i -lt 3 -and $script:appleRepeat[(& $name)] -ne $c.mode; $i++) { & $press }
    return @{ ok = $true; mode = $script:appleRepeat[(& $name)] }
  } finally {
    if ($minimized) { $null = [IJWA.Win]::ShowWindow($h, 7); Start-Sleep -Milliseconds 250; SeeThrough $h $false }   # SW_SHOWMINNOACTIVE
  }
}

# ---- the song playing ----

# The now-playing bar's title links to the album, with the artists' links right after it; the Now Playing view's
# title link carries the song itself ("uri=spotify:track:"). Minimized, Spotify shows nothing of its contents.
function Now($c) {
  $Title = [string]$c.title
  $window = SpotifyWindow
  if (-not $window) { return @{ error = 'no window' } }
  if ([IJWA.Win]::IsIconic($window.MainWindowHandle)) { return @{ error = 'minimized' } }
  $root = $A::FromHandle($window.MainWindowHandle)
  $track = $null; $album = $null; $artists = @(); $seen = @{}
  for ($try = 0; $try -lt 4 -and -not $album; $try++) {
    if ($try) { Start-Sleep -Milliseconds 500 }
    $inBar = $false
    # Asked for everything and sorted here: asked for links alone, Spotify's tree sometimes answers with none.
    foreach ($link in (Scan $root ([System.Windows.Automation.Condition]::TrueCondition))) {
      if ((KindOf $link) -ne $Types::Hyperlink) { continue }
      $address = AddressOf $link
      if (-not $address) { continue }
      $name = NameOf $link
      if ($name -eq $Title -and $address -match 'uri=spotify%3Atrack%3A([A-Za-z0-9]{22})') { $track = $Matches[1] }
      if ($name -eq $Title -and -not $album -and $address -match '/album/([A-Za-z0-9]{22})') { $album = $Matches[1]; $inBar = $true; continue }
      if ($inBar) {
        if ($address -match '/artist/([A-Za-z0-9]{22})') {
          if (-not $seen[$Matches[1]]) { $seen[$Matches[1]] = $true; $artists += @{ name = $name; id = $Matches[1] } }
        } else { $inBar = $false }
      }
    }
  }
  return @{ track = $track; album = $album; artists = $artists }
}

Say @{ ready = $true }
while ($true) {
  Arrived
  if ($script:waiting.Count -eq 0) { $null = $script:pending.Wait(250); continue }
  $text = $script:waiting.Dequeue()
  try { $c = $text | ConvertFrom-Json } catch { continue }
  $answer = $null
  try {
    if ($c.do -eq 'play') { $answer = Play $c }
    elseif ($c.do -eq 'now') { $answer = Now $c }
    elseif ($c.do -eq 'volume') { $answer = Volume $c }
    elseif ($c.do -eq 'apple') {
      $answer = Apple $c
      if ($answer.stuck) {
        Get-Process AppleMusic -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Seconds 2
        $answer = Apple $c
        $answer.restarted = $true
      }
    }
    elseif ($c.do -eq 'apple-seek') { $answer = AppleSeek $c }
    elseif ($c.do -eq 'apple-repeat') { $answer = AppleRepeat $c }
  } catch { $answer = @{ ok = $false; error = "$_" } }
  if ($answer) { $answer.seq = $c.seq; Say $answer }
}
