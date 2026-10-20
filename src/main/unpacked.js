// Files Windows itself runs or reads — the helpers' PowerShell scripts, the tray's picture — can't be inside app.asar,
// which only iBaila can read: the installer keeps them beside it, in app.asar.unpacked (package.json's asarUnpack).
// Run from loose files, a path is what it is.
const unpacked = (file) => file.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
module.exports = { unpacked };
