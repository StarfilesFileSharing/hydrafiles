import { app, BrowserWindow } from 'electron';
import path from 'path';
import squirrelStartup from 'electron-squirrel-startup';
import fs from 'fs';

const DIRNAME = path.resolve('app/')

const glob = {}

if (squirrelStartup) app.quit();

if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient('hydra', process.execPath, [path.resolve(process.argv[1])])
} else {
  app.setAsDefaultProtocolClient('hydra')
}

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(DIRNAME, 'preload.js'),
    },
  });
  glob.mainWindow = mainWindow;
  mainWindow.loadFile(path.join(DIRNAME, 'index.html'));
  mainWindow.webContents.openDevTools();

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('config', JSON.parse(fs.readFileSync(path.join(DIRNAME, '../config.json'), 'utf8')));
    setInterval(() => mainWindow.webContents.send('config', JSON.parse(fs.readFileSync(path.join(DIRNAME, '../config.json'), 'utf8'))), 5000);

    fs.readdir(path.join(DIRNAME, '../files/'), (err, files) => {
      if (err) {
        console.error('Error reading files:', err);
        return;
      }

      files = files.map(file => {
        const stats = fs.statSync(path.join(DIRNAME, '../files/', file));
        return { hash: file, size: stats.size };
      });

      mainWindow.webContents.send('files', files);

      setInterval(() => {
        fs.readdir(path.join(DIRNAME, '../files/'), (err, files) => {
          if (err) {
            console.error('Error reading files:', err);
            return;
          }

          files = files.map(file => {
            const stats = fs.statSync(path.join(DIRNAME, '../files/', file));
            return { hash: file, size: stats.size };
          });

          mainWindow.webContents.send('files', files);
        });
      }, 5000);
    });
  });

  // on message
  mainWindow.webContents.on('ipc-message', (event, channel, ...args) => {
    if(channel === 'config'){
      fs.writeFileSync(path.join(DIRNAME, '../config.json'), JSON.stringify(args[0]));
    }
  });
};

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (glob.mainWindow) {
      if (glob.mainWindow.isMinimized()) glob.mainWindow.restore()
      glob.mainWindow.focus()
    }
    glob.mainWindow.webContents.send('url-scheme', commandLine.pop());
  })
}

app.on('open-url', (event, url) => {
  glob.mainWindow.webContents.send('url-scheme', url);
})