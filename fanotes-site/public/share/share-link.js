// Decisions for an editable share link. The page paints these strings.
// Copy and live shares do not read this file.
var FANOTES_SHARE_LINK = {
  protocol: 'fanotes://share/',
  prompts: {
    viewOrEdit: 'Im Browser ansehen oder in der Desktop-App bearbeiten?',
    view: 'Im Browser ansehen',
    desktop: 'In der Desktop-App bearbeiten',
    downloadOrInstalled: 'Installer herunterladen oder ist FaNotes schon installiert?',
    download: 'Installer herunterladen',
    installed: 'FaNotes ist schon installiert',
    again: 'Öffne die Datei jetzt in FaNotes.',
  },
  openLabel: 'In FaNotes öffnen',
  installers: {
    windows: '/download/windows-installer',
    linux: '/download/appimage',
    mac: '/download/appimage',
  },
  openRequest: function (id) {
    return { protocol: FANOTES_SHARE_LINK.protocol + id, id: id }
  },
  installerFor: function (platform) {
    var name = platform === 'windows' || platform === 'win32' ? 'windows' : platform === 'mac' || platform === 'darwin' ? 'mac' : 'linux'
    return FANOTES_SHARE_LINK.installers[name]
  },
}
