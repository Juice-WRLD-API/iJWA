# What Windows says is playing (the system media session: Spotify, Apple Music, YouTube Music in a browser,
# anything), as one JSON line whenever something changes and every two seconds while a song plays. The
# artwork is sent once per song. Commands come in on the input, one per line:
#   toggle | play | pause | next | previous | seek <seconds> | shuffle on|off | repeat None|Track|List | open <spotify address>
#   prefer <pattern>   follow the session of the app whose ID matches (the place the user chose), not Windows' current one
#   pause-app <app ID> pause that app's session: one place plays
# Every two seconds it also lists every app's session — which play, and what — for music playing in two places at once.
# Every second it looks whether an app fills a display (a game, a video in full screen): { fullscreen: [rects] } when
# that changes, for the light to step aside there.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Media.MediaPlaybackAutoRepeatMode, Windows.Media, ContentType = WindowsRuntime]

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($operation, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    $task.Wait(5000) | Out-Null
    $task.Result
}
# Run by agents.ps1, lines go to and come from iJWA through it; run on its own, through the console.
if (-not $IJWAOut) { $IJWAOut = [Console]::Out }
function Say($object) { $IJWAOut.WriteLine(($object | ConvertTo-Json -Compress -Depth 4)); $IJWAOut.Flush() }

Add-Type -Namespace IJWAScreen -Name Full -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
[DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO info);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
[DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string name);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("kernel32.dll")] public static extern bool GetSystemPowerStatus(out POWER p);
[StructLayout(LayoutKind.Sequential)] public struct POWER { public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag; public int BatteryLifeTime, BatteryFullLifeTime; }
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
[StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
'@
# The display the window in front fills, if it fills one: not the desktop, the taskbar, or a window merely maximized
# (that leaves the taskbar showing).
function FullScreen {
    $h = [IJWAScreen.Full]::GetForegroundWindow()
    if ($h -eq [IntPtr]::Zero) { return @() }
    $class = New-Object System.Text.StringBuilder 64
    $null = [IJWAScreen.Full]::GetClassName($h, $class, 64)
    if ($class.ToString() -match '^(Progman|WorkerW|Shell_TrayWnd|Shell_SecondaryTrayWnd)$') { return @() }
    $r = New-Object IJWAScreen.Full+RECT
    if (-not [IJWAScreen.Full]::GetWindowRect($h, [ref]$r)) { return @() }
    $info = New-Object IJWAScreen.Full+MONITORINFO
    $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
    if (-not [IJWAScreen.Full]::GetMonitorInfo([IJWAScreen.Full]::MonitorFromWindow($h, 2), [ref]$info)) { return @() }
    $m = $info.rcMonitor
    $state = 0; $null = [IJWAScreen.Full]::SHQueryUserNotificationState([ref]$state)
    # 3: a game in exclusive full screen; otherwise the window covers the whole display, taskbar and all.
    if ($state -eq 3 -or ($r.L -le $m.L -and $r.T -le $m.T -and $r.R -ge $m.R -and $r.B -ge $m.B)) {
        return @(@{ x = $m.L; y = $m.T; width = $m.R - $m.L; height = $m.B - $m.T })
    }
    return @()
}
$lastFull = '[]'
# Windows' Energy saver (Battery saver) on or off: said when that changes.
$lastSaver = $null

# iJWA's desktop windows (the player, the list, the clock; their handles told by the app) live just above the
# desktop, as the Mac's do at its desktop level: under every app, over the desktop wherever it is. Win+D raises the
# desktop over all the ordinary windows: they rise with it; the desktop lowered again, they go back down with it. They
# are put there from here, never made topmost (placed after a topmost window, a window would become one).
$deskWindows = @()
$deskFailed = $false
$watchFront = $false
# The light shown only on the desktop: whether the desktop (or iJWA) is the window in front, told when it changes.
$watchDesk = $false
$ownPid = 0
$lastDesk = $null
$lastFront = [IntPtr]::Zero
function Topmost($h) { return ([IJWAScreen.Full]::GetWindowLong($h, -20) -band 8) -ne 0 }
function KeepAtDesktop {
    if (-not $deskWindows.Count) { return }
    $desk = [IJWAScreen.Full]::FindWindow('Progman', [NullString]::Value)   # $null would be sent as ""
    if ($desk -eq [IntPtr]::Zero) { return }
    # The WorkerW windows right above Progman (a live wallpaper such as Wallpaper Engine's, the icons) are the desktop
    # too, not an app that came between: taken for one, the check failed on every pass and the windows were put back
    # under the wallpaper, a flash every few seconds (Isaac's report, Windows 10 with Wallpaper Engine, 2026-10-11).
    $up = [IJWAScreen.Full]::GetWindow($desk, 3)
    while ($up -ne [IntPtr]::Zero) {
        $class = New-Object System.Text.StringBuilder 32
        $null = [IJWAScreen.Full]::GetClassName($up, $class, 32)
        if ($class.ToString() -ne 'WorkerW') { break }
        $desk = $up
        $up = [IJWAScreen.Full]::GetWindow($up, 3)
    }
    $ours = @{}; foreach ($h in $deskWindows) { $ours[[int64]$h] = $true }
    $wrong = $false
    # One of them under the desktop (it rose over them), or one made topmost?
    $w = [IJWAScreen.Full]::GetWindow($desk, 2)
    while ($w -ne [IntPtr]::Zero) { if ($ours[[int64]$w]) { $wrong = $true; break }; $w = [IJWAScreen.Full]::GetWindow($w, 2) }
    foreach ($h in $deskWindows) { if (Topmost $h) { $wrong = $true } }
    # The first ordinary window shown above the desktop not one of them (an app came between)?
    if (-not $wrong) {
        $w = [IJWAScreen.Full]::GetWindow($desk, 3)
        while ($w -ne [IntPtr]::Zero) {
            if ([IJWAScreen.Full]::IsWindowVisible($w) -and -not [IJWAScreen.Full]::IsIconic($w) -and -not (Topmost $w)) { $wrong = -not $ours[[int64]$w]; break }
            $w = [IJWAScreen.Full]::GetWindow($w, 3)
        }
    }
    if (-not $wrong) { return }
    # Right above the desktop: after the window just above it — or, with the desktop risen to the top of the ordinary
    # windows, at their top. The clock first, the player last, so the player ends highest.
    $above = [IJWAScreen.Full]::GetWindow($desk, 3)
    $insert = if ($above -eq [IntPtr]::Zero -or (Topmost $above) -or $ours[[int64]$above]) { [IntPtr]0 } else { $above }
    for ($i = $deskWindows.Count - 1; $i -ge 0; $i--) {
        $h = [IntPtr][int64]$deskWindows[$i]
        if (Topmost $h) { $null = [IJWAScreen.Full]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0013) }   # HWND_NOTOPMOST
        $null = [IJWAScreen.Full]::SetWindowPos($h, $insert, 0, 0, 0, 0, 0x0013)
    }
}


# PowerShell sees the picture's stream as a bare COM object it can't cast; a cast made through reflection asks the
# object itself, and works.
$asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))
$contentType = [Windows.Storage.Streams.IContentTypeProvider].GetProperty('ContentType')
function Thumbnail($props) {
    if (-not $props.Thumbnail) { return $null }
    try {
        $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        $net = $asStream.Invoke($null, @($stream))
        $memory = New-Object System.IO.MemoryStream
        $net.CopyTo($memory)
        $net.Dispose()
        if ($memory.Length -eq 0) { return $null }
        return @{ data = [Convert]::ToBase64String($memory.ToArray()); type = [string]$contentType.GetValue($stream) }
    } catch { return $null }
}

# Opening a song in Spotify without Spotify taking the screen: Spotify comes forward when it is handed an address,
# so it is put straight back as it was — minimized, hidden in the tray, or behind the window the user was in.
Add-Type -Namespace IJWA -Name User -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
[DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int index, int value);
[DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
[DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attribute, ref int value, int size);
'@
# See-through, and without the animations of opening and minimizing: Spotify is there for the song, never seen.
function Unseen($handle, $on) {
    if (-not $handle -or $handle -eq [IntPtr]::Zero) { return }
    $style = [IJWA.User]::GetWindowLong($handle, -20)
    $off = [int]$on
    $null = [IJWA.User]::DwmSetWindowAttribute($handle, 3, [ref]$off, 4)   # DWMWA_TRANSITIONS_FORCEDISABLED
    if ($on) { $null = [IJWA.User]::SetWindowLong($handle, -20, $style -bor 0x80000); $null = [IJWA.User]::SetLayeredWindowAttributes($handle, 0, 0, 2) }
    else { $null = [IJWA.User]::SetLayeredWindowAttributes($handle, 0, 255, 2); $null = [IJWA.User]::SetWindowLong($handle, -20, $style -band (-bnot 0x80000)) }
}
function SpotifyWindow { (Get-Process Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle }
function IsSpotify($handle) {
    $id = [uint32]0
    $null = [IJWA.User]::GetWindowThreadProcessId($handle, [ref]$id)
    return [bool](Get-Process -Id $id -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'Spotify' })
}
function OpenQuietly($address) {
    $before = [IJWA.User]::GetForegroundWindow()
    $window = SpotifyWindow
    $state = if (-not $window) { 'hidden' } elseif ([IJWA.User]::IsIconic($window)) { 'minimized' } elseif (IsSpotify $before) { 'front' } else { 'behind' }
    if ($state -ne 'front') { Unseen $window $true }
    Start-Process $address
    if ($state -eq 'front') { return }
    # Spotify takes a moment to come forward with the song; then it goes back as it was.
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 25
        $now = SpotifyWindow
        if ($state -eq 'hidden' -and $now) { Unseen $now $true }
        if (IsSpotify ([IJWA.User]::GetForegroundWindow())) { break }
    }
    Start-Sleep -Milliseconds 100
    $now = SpotifyWindow
    switch ($state) {
        'minimized' { if ($now) { $null = [IJWA.User]::ShowWindow($now, 7) } }          # SW_SHOWMINNOACTIVE
        'hidden'    { if ($now) { $null = [IJWA.User]::ShowWindow($now, 0) } }          # SW_HIDE: back in the tray
        'behind'    { }
    }
    # The window the user was in takes the keys back (no key presses faked: a lone Alt puts windows in menu mode).
    if ($before -ne [IntPtr]::Zero -and -not (IsSpotify $before)) { $null = [IJWA.User]::SetForegroundWindow($before) }
    Start-Sleep -Milliseconds 150
    if ($now) { Unseen $now $false }
}

$prefer = ''
function Followed {
    if ($prefer) {
        $chosen = $manager.GetSessions() | Where-Object { $_.SourceAppUserModelId -match $prefer } | Select-Object -First 1
        return $chosen
    }
    return $manager.GetCurrentSession()
}

function Command($session, $text) {
    if ($text.StartsWith('open ')) { OpenQuietly $text.Substring(5).Trim(); return }
    if ($text.StartsWith('prefer')) { $script:prefer = $text.Substring(6).Trim(); $script:lastKey = ''; return }
    # iJWA's desktop windows, top one first: kept just above the desktop.
    # While the desk is cleared (cleardesk.js): which app's window is in front, told when it changes.
    if ($text.StartsWith('watch-desk')) {
        $parts = $text.Trim().Split(' ')
        $script:watchDesk = $parts[1] -eq 'on'
        if ($parts.Count -gt 2) { $script:ownPid = [int]$parts[2] }
        $script:lastDesk = $null
        return
    }
    if ($text.StartsWith('watch-front')) { $script:watchFront = $text.Trim().EndsWith('on'); $script:lastFront = [IntPtr]::Zero; return }
    if ($text.StartsWith('desk-windows')) { $script:deskWindows = @($text.Substring(12).Trim().Split(' ') | Where-Object { $_ } | ForEach-Object { [int64]$_ }); return }
    if ($text.StartsWith('pause-app ')) {
        $app = $text.Substring(10).Trim()
        foreach ($other in $manager.GetSessions()) { if ($other.SourceAppUserModelId -eq $app) { $null = Await ($other.TryPauseAsync()) ([bool]) } }
        return
    }
    if ($null -eq $session) { return }
    $parts = $text.Trim().Split(' ')
    switch ($parts[0]) {
        'toggle'   { $null = Await ($session.TryTogglePlayPauseAsync()) ([bool]) }
        'play'     { $null = Await ($session.TryPlayAsync()) ([bool]) }
        'pause'    { $null = Await ($session.TryPauseAsync()) ([bool]) }
        'next'     { $null = Await ($session.TrySkipNextAsync()) ([bool]) }
        'previous' { $null = Await ($session.TrySkipPreviousAsync()) ([bool]) }
        'seek'     { $null = Await ($session.TryChangePlaybackPositionAsync([int64]([double]$parts[1] * 10000000))) ([bool]) }
        'shuffle'  { $null = Await ($session.TryChangeShuffleActiveAsync($parts[1] -eq 'on')) ([bool]) }
        'repeat'   { $null = Await ($session.TryChangeAutoRepeatModeAsync([Windows.Media.MediaPlaybackAutoRepeatMode]$parts[1])) ([bool]) }
    }
}

$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
# [Console]::In reads synchronously even when asked to read asynchronously: a reader over the raw stream doesn't.
$stdin = if ($IJWAIn) { $IJWAIn } else { New-Object System.IO.StreamReader([Console]::OpenStandardInput()) }
$pending = $stdin.ReadLineAsync()
$lastKey = ''
$lastShape = ''
$lastSent = [DateTime]::MinValue
$thumbTries = 0
$tick = 0
while ($true) {
    $force = $false
    # Commands are answered within a tenth of a second; what is playing is read twice a second.
    if ($pending.IsCompleted) {
        $text = $pending.Result
        if ($null -eq $text) { exit }   # the app is gone
        $pending = $stdin.ReadLineAsync()
        try { Command (Followed) $text } catch { }
        $force = $true
        Start-Sleep -Milliseconds 120   # the player takes a moment to say what it did
    }
    $tick++
    if (($tick % 4) -eq 0) { try { KeepAtDesktop } catch { if (-not $deskFailed) { $deskFailed = $true; Say @{ deskError = "$_" } } } }
    if ($watchFront -and ($tick % 3) -eq 0) {
        $h = [IJWAScreen.Full]::GetForegroundWindow()
        if ($h -ne $lastFront) {
            $lastFront = $h
            [uint32]$owner = 0
            $null = [IJWAScreen.Full]::GetWindowThreadProcessId($h, [ref]$owner)
            Say @{ front = [int]$owner }
        }
    }
    if ($watchDesk -and ($tick % 3) -eq 0) {
        $h = [IJWAScreen.Full]::GetForegroundWindow()
        $class = New-Object System.Text.StringBuilder 64
        $null = [IJWAScreen.Full]::GetClassName($h, $class, 64)
        $name = $class.ToString()
        # The taskbar in front changes nothing: it's on the way somewhere.
        if ($name -notmatch '^(Shell_TrayWnd|Shell_SecondaryTrayWnd)$') {
            [uint32]$owner = 0
            $null = [IJWAScreen.Full]::GetWindowThreadProcessId($h, [ref]$owner)
            $desk = $h -eq [IntPtr]::Zero -or $name -match '^(Progman|WorkerW)$' -or ($ownPid -and [int]$owner -eq $ownPid)
            if ($desk -ne $lastDesk) { $lastDesk = $desk; Say @{ desktopFront = $desk } }
        }
    }
    if (($tick % 10) -eq 0) {
        try {
            $full = @(FullScreen)
            $said = ConvertTo-Json -Compress -InputObject $full -Depth 3
            if ($said -ne $lastFull) { $lastFull = $said; Say @{ fullscreen = $full } }
            $power = New-Object IJWAScreen.Full+POWER
            if ([IJWAScreen.Full]::GetSystemPowerStatus([ref]$power)) {
                $saver = ($power.SystemStatusFlag -band 1) -ne 0
                if ($saver -ne $lastSaver) { $lastSaver = $saver; Say @{ energySaver = $saver } }
            }
        } catch { }
    }
    # Every app's session, every two seconds: which play, and what.
    if (($tick % 20) -eq 0) {
        try {
            $all = @()
            foreach ($one in $manager.GetSessions()) {
                $info = $one.GetPlaybackInfo()
                $item = @{ app = [string]$one.SourceAppUserModelId; playing = ($info.PlaybackStatus -eq 4) }
                if ($item.playing) {
                    $p = Await ($one.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
                    $item.title = [string]$p.Title; $item.artist = [string]$p.Artist
                }
                $all += $item
            }
            Say @{ sessions = $all }
        } catch { }
    }
    if (-not $force -and ($tick % 5) -ne 0) { Start-Sleep -Milliseconds 100; continue }
    try {
        $session = Followed
        if ($null -eq $session) {
            if ($lastShape -ne 'none') { Say @{ none = $true; playing = $false }; $lastShape = 'none'; $lastKey = '' }
            Start-Sleep -Milliseconds 100
            continue
        }
        $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $timeline = $session.GetTimelineProperties()
        $playback = $session.GetPlaybackInfo()
        $playing = ($playback.PlaybackStatus -eq 4)   # 4 = Playing
        $position = $timeline.Position.TotalSeconds
        # The player says where it was when it last said anything; where it is now runs on from there.
        if ($playing -and $timeline.LastUpdatedTime.Year -gt 2000) {
            $position += ([DateTimeOffset]::UtcNow - $timeline.LastUpdatedTime).TotalSeconds
        }
        $controls = $playback.Controls
        $line = @{
            title    = [string]$props.Title
            artist   = [string]$props.Artist
            album    = [string]$props.AlbumTitle
            albumArtist = [string]$props.AlbumArtist
            playing  = $playing
            duration = [math]::Round(($timeline.EndTime - $timeline.StartTime).TotalSeconds, 2)
            app      = [string]$session.SourceAppUserModelId
            shuffle  = if ($null -ne $playback.IsShuffleActive) { [bool]$playback.IsShuffleActive } else { $null }
            repeat   = if ($null -ne $playback.AutoRepeatMode) { [string]$playback.AutoRepeatMode } else { $null }
            can      = @{ next = $controls.IsNextEnabled; previous = $controls.IsPreviousEnabled; seek = $controls.IsPlaybackPositionEnabled;
                          shuffle = $controls.IsShuffleEnabled; repeat = $controls.IsRepeatEnabled }
        }
        $key = "$($line.title)|$($line.artist)|$($line.album)|$($line.app)"
        $shape = ($line | ConvertTo-Json -Compress -Depth 3)
        $line.position = [math]::Round([math]::Max($position, 0), 2)
        if ($key -ne $lastKey) {
            $lastKey = $key
            $line.changed = $true
            $thumbTries = 0
        }
        # The artwork, once per song; some players set it a moment after the title, so a few more tries.
        if ($line.changed -or ($thumbTries -gt 0 -and $thumbTries -lt 4)) {
            $thumb = Thumbnail $props
            if ($thumb) { $line.thumb = $thumb.data; $line.thumbType = $thumb.type; $thumbTries = 99 }
            else { $thumbTries++ }
        }
        $now = [DateTime]::UtcNow
        if ($force -or $line.changed -or $line.thumb -or $shape -ne $lastShape -or ($playing -and ($now - $lastSent).TotalSeconds -ge 2)) {
            Say $line
            $lastShape = $shape
            $lastSent = $now
        }
    } catch { Say @{ none = $true; playing = $false }; $lastShape = 'none' }
    Start-Sleep -Milliseconds 100
}
