import { contextBridge, ipcRenderer } from 'electron';
import type { SftApi } from './ipc-types.ts';

const api: SftApi = {
  platform: process.platform,

  getState: () => ipcRenderer.invoke('state:get'),
  onPeers: (cb) => { ipcRenderer.on('peers', (_e, peers) => cb(peers)); },

  games: (deviceId, password) => ipcRenderer.invoke('games:list', deviceId, password ?? ''),
  gameIcon: (deviceId, appId, password) => ipcRenderer.invoke('games:icon', deviceId, appId, password ?? ''),

  enqueue: (req) => ipcRenderer.invoke('jobs:enqueue', req),
  cancelJob: (id) => ipcRenderer.invoke('jobs:cancel', id),
  pauseJob: (id) => ipcRenderer.invoke('jobs:pause', id),
  resumeJob: (id) => ipcRenderer.invoke('jobs:resume', id),
  removeJob: (id) => ipcRenderer.invoke('jobs:remove', id),
  clearFinishedJobs: () => ipcRenderer.invoke('jobs:clearFinished'),
  jobs: () => ipcRenderer.invoke('jobs:list'),
  onJobs: (cb) => { ipcRenderer.on('jobs', (_e, jobs) => cb(jobs)); },

  inbound: () => ipcRenderer.invoke('inbound:list'),

  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
};

contextBridge.exposeInMainWorld('sft', api);
