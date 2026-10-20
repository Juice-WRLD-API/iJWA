// The sound of the user's own songs (FilePlayer.swift's player): one audio element in a window never shown, told
// what to play by the app and telling it back where the song is. Its media session makes the keyboard's media keys
// and Windows' media flyout steer it, as they do any player.
const api = window.ibaila;
const audio = document.getElementById('audio');
let loadedID = null;

function tell(extra = {}) {
  api.send('player-state', { id: loadedID, playing: !audio.paused && !audio.ended, position: audio.currentTime || 0,
    duration: Number.isFinite(audio.duration) ? audio.duration : 0, ...extra });
}

api.listen('player-load', async ({ id, url, play, position, song }) => {
  loadedID = id;
  audio.src = url;
  if (position) audio.currentTime = position;
  navigator.mediaSession.metadata = new MediaMetadata({ title: song.title, artist: song.artist, album: song.album || '',
    artwork: song.art ? [{ src: song.art, sizes: '512x512', type: 'image/jpeg' }] : [] });
  if (play) { try { await audio.play(); } catch { tell({ failed: true }); return; } }
  tell();
});

api.listen('player-command', async ({ action, value }) => {
  if (action === 'play') { try { await audio.play(); } catch { tell({ failed: true }); } }
  if (action === 'pause') audio.pause();
  if (action === 'seek' && Number.isFinite(value)) audio.currentTime = value;
  if (action === 'stop') { audio.pause(); audio.removeAttribute('src'); audio.load(); loadedID = null; navigator.mediaSession.metadata = null; }
  tell();
});

for (const name of ['play', 'pause', 'loadedmetadata', 'seeked', 'durationchange']) audio.addEventListener(name, () => tell());
audio.addEventListener('ended', () => tell({ ended: true }));
audio.addEventListener('error', () => tell({ failed: true }));

// The media keys and the flyout's buttons.
for (const action of ['play', 'pause', 'nexttrack', 'previoustrack']) {
  navigator.mediaSession.setActionHandler(action, () => api.send('player-action', action));
}
navigator.mediaSession.setActionHandler('seekto', (details) => api.send('player-action', 'seekto', details.seekTime));
