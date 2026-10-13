#!/usr/bin/env node
// Starts the audio helper outside the panel server's job object. On Windows,
// Node puts every child it starts without `detached` into a job that is killed
// the moment the parent exits, so a helper started straight from the panel died
// with it and never got to put the music back. The panel starts this relay
// detached, which keeps it out of that job, and the relay hands its own stdin,
// stdout and stderr straight to the helper: the helper still talks to the panel
// directly and still sees EOF the moment the panel goes away. (PowerShell
// itself cannot be started detached: with no console it silently never runs.)
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
if (!command) process.exit(2);
const helper = spawn(command, args, { stdio: 'inherit', windowsHide: true });
helper.on('error', () => process.exit(1));
helper.on('exit', (code) => process.exit(code ?? 1));
