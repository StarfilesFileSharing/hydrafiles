import { app, BrowserWindow } from 'electron';
import path from 'path';
import squirrelStartup from 'electron-squirrel-startup';
import fs from 'fs';

const DIRNAME = path.resolve('app/')

if (squirrelStartup) app.quit();

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(DIRNAME, 'preload.js'),
    },
  });
  mainWindow.loadFile(path.join(DIRNAME, 'index.html'));
  mainWindow.webContents.openDevTools();

  mainWindow.webContents.on('did-finish-load', () => {
    const configFile = path.join(DIRNAME, '../config.json');
    const configContents = fs.readFileSync(configFile, 'utf8');
    mainWindow.webContents.send('config', JSON.parse(configContents));

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