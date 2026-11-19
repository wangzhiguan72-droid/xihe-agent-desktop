'use strict';

// 便携化路径解析：程序目录、可写数据目录和工作区分开。
// 开发模式（直接 node core/server.js / electron .）保持旧布局：workspace 在程序目录的上一级。
// 打包模式由 main.js 设置 XIHE_HOME=便携根目录，data/ 与 workspace/ 都落在便携包内。
const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');
const HOME = process.env.XIHE_HOME ? path.resolve(process.env.XIHE_HOME) : APP_DIR;
const DATA_DIR = process.env.XIHE_DATA_DIR ? path.resolve(process.env.XIHE_DATA_DIR) : path.join(HOME, 'data');
const WORKSPACE = process.env.XIHE_WORKSPACE
  ? path.resolve(process.env.XIHE_WORKSPACE)
  : (process.env.XIHE_HOME ? path.join(HOME, 'workspace') : path.join(path.resolve(APP_DIR, '..'), 'workspace'));

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { APP_DIR, HOME, DATA_DIR, WORKSPACE, ensureDir };
