import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { format } from 'node:util';
import { ErrorTypeEnum, type Client } from './api.js';

type LogType = 'files' | 'efirmaLogin' | 'passwordLogin' | 'sat';

type ScriptSummary = {
  successfulClients: number;
  failedClients: number;
  totalClients: number;
  startDate: Date;
  endDate: Date;
  durationMs: number;
};

const logFileByType: Record<LogType, string> = {
  files: 'Error_Archivos.log',
  efirmaLogin: 'Error_login_efirma.log',
  passwordLogin: 'Error_login_contrasena.log',
  sat: 'Error_sat.log',
};

const errorTypeByLogType: Record<LogType, ErrorTypeEnum> = {
  files: ErrorTypeEnum.ARCHIVOS,
  efirmaLogin: ErrorTypeEnum.LOGIN_EFIRMA,
  passwordLogin: ErrorTypeEnum.LOGIN_CONTRASEÑA,
  sat: ErrorTypeEnum.SAT,
};

const historyLogFileName = 'history.log';
const logFileNames = [...Object.values(logFileByType), 'resumen.log', historyLogFileName];
let historyLoggerInstalled = false;
let historyLogQueue: Promise<void> = Promise.resolve();

/**
 * Normalizes a WSL path by converting Windows-style paths to Unix-style.
 * @param value - The path to normalize.
 * @returns The normalized path.
 */
export const normalizeWslPath = (value: string): string => {
  const cleaned = value.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  const wslPrefix = '\\\\wsl$\\Ubuntu\\';
  if (cleaned.startsWith(wslPrefix)) {
    return `/${cleaned.slice(wslPrefix.length).replace(/\\/g, '/')}`;
  }
  return cleaned;
};

/**
 * Reads the first line of a file.
 * @param filePath - The path to the file.
 * @returns The first line of the file, trimmed.
 */
export const readFirstLine = async (filePath: string): Promise<string> => {
  const content = await readFile(filePath, 'utf-8');
  const [firstLine] = content.split(/\r?\n/);
  return (firstLine ?? '').trim();
};

/**
 * Reads the entire content of a file.
 * @param filePath - The path to the file.
 * @returns The content of the file as a string.
 */
export const readFileContent = async (filePath: string): Promise<string> => {
  return await readFile(filePath, 'utf-8');
};

export const getLogDirectory = (date = new Date()): string => {
  const dateFolder = formatDateFolder(date);
  const runFolder = formatRunFolder(date);
  return join('LOGS', dateFolder, runFolder);
};

export const ensureLogDirectory = async (date = new Date()): Promise<string> => {
  const logDirectory = getLogDirectory(date);
  await mkdir(logDirectory, { recursive: true });
  await Promise.all(logFileNames.map((fileName) => appendFile(join(logDirectory, fileName), '', 'utf-8')));
  return logDirectory;
};

export const installHistoryLogger = async (runDate = new Date()): Promise<void> => {
  if (historyLoggerInstalled) {
    return;
  }

  const logDirectory = await ensureLogDirectory(runDate);
  historyLoggerInstalled = true;
  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const writeHistoryEntry = (level: 'LOG' | 'WARN' | 'ERROR', args: unknown[]): void => {
    const message = stripAnsiCodes(format(...args));
    const logEntry = `[${formatDateTime(new Date())}] [${level}] ${message}\n`;

    historyLogQueue = historyLogQueue
      .then(async () => {
        await appendFile(join(logDirectory, historyLogFileName), logEntry, 'utf-8');
      })
      .catch((logError) => {
        originalConsole.error('Error al escribir en history.log:', logError);
      });
  };

  console.log = (...args: unknown[]) => {
    originalConsole.log(...args);
    writeHistoryEntry('LOG', args);
  };

  console.warn = (...args: unknown[]) => {
    originalConsole.warn(...args);
    writeHistoryEntry('WARN', args);
  };

  console.error = (...args: unknown[]) => {
    originalConsole.error(...args);
    writeHistoryEntry('ERROR', args);
  };
};

export const flushHistoryLogger = async (): Promise<void> => {
  await historyLogQueue;
};

/**
 * Logs an error to its classified file with the RFC and the failure reason.
 * @param rfc - The RFC of the client.
 * @param errorMessage - The error message to save in the file.
 */
export const logError = async (client: Client, errorMessage: string, runDate = new Date()): Promise<void> => {
  const { logType, description } = getClientErrorLogDetails(client, errorMessage);
  const logEntry = `${client.rfc} - ${description}\n`;

  try {
    const logDirectory = await ensureLogDirectory(runDate);
    await appendFile(join(logDirectory, logFileByType[logType]), logEntry, 'utf-8');
  } catch (logError) {
    console.error('Error al escribir en el log:', logError);
  }
};

export const getClientErrorLogDetails = (
  client: Client,
  errorMessage: string,
): { logType: LogType; errorType: ErrorTypeEnum; description: string } => {
  const cleanErrorMessage = cleanLogText(errorMessage);
  const logType = classifyError(cleanErrorMessage, client);

  return {
    logType,
    errorType: errorTypeByLogType[logType],
    description: formatLogReason(logType, cleanErrorMessage),
  };
};

export const logSummary = async (summary: ScriptSummary, runDate = summary.startDate): Promise<void> => {
  const logEntry = [
    `Clientes analizados: ${summary.successfulClients}`,
    `Clientes fallidos: ${summary.failedClients}`,
    `Clientes totales: ${summary.totalClients}`,
    `Tiempo total: ${Math.floor(summary.durationMs / 1000)} segundos.`,
    `Fecha | Hora inicio: ${formatDateTime(summary.startDate)}`,
    `Fecha | Hora termino: ${formatDateTime(summary.endDate)}`,
    '',
  ].join('\n');

  try {
    const logDirectory = await ensureLogDirectory(runDate);
    await appendFile(join(logDirectory, 'resumen.log'), logEntry, 'utf-8');
  } catch (logError) {
    console.error('Error al escribir el resumen del log:', logError);
  }
};

const classifyError = (errorMessage: string, client: Client): LogType => {
  const normalizedError = normalizeForMatching(errorMessage);

  if (isFileError(normalizedError)) {
    return 'files';
  }

  if (clientUsesPassword(client)) {
    return 'passwordLogin';
  }

  if (isEfirmaLoginError(normalizedError)) {
    return 'efirmaLogin';
  }

  return 'sat';
};

const formatLogReason = (logType: LogType, errorMessage: string): string => {
  if (logType === 'files') {
    return getMissingFileReason(errorMessage);
  }

  if (logType === 'passwordLogin') {
    return getPasswordLoginReason(errorMessage);
  }

  if (logType === 'sat') {
    return getSatFailureReason(errorMessage);
  }

  return errorMessage;
};

const isFileError = (normalizedError: string): boolean =>
  normalizedError.includes('faltan archivos') ||
  normalizedError.includes('falta archivo') ||
  normalizedError.includes('enoent') ||
  normalizedError.includes('no such file') ||
  normalizedError.includes('certificado.cer') ||
  normalizedError.includes('llave.key') ||
  normalizedError.includes('password.txt');

const isEfirmaLoginError = (normalizedError: string): boolean =>
  normalizedError.includes('error en login sat') ||
  normalizedError.includes('certificado') ||
  normalizedError.includes('efirma') ||
  normalizedError.includes('firma') ||
  normalizedError.includes('privatekeypassword') ||
  normalizedError.includes('buttonfiel') ||
  normalizedError.includes('submit') ||
  normalizedError.includes('enviar');

const getMissingFileReason = (errorMessage: string): string => {
  const normalizedError = normalizeForMatching(errorMessage);
  const missingFiles: string[] = [];

  if (normalizedError.includes('.cer') || normalizedError.includes('certificado')) {
    missingFiles.push('.cer');
  }
  if (normalizedError.includes('.key') || normalizedError.includes('llave')) {
    missingFiles.push('.key');
  }
  if (
    normalizedError.includes('password') ||
    normalizedError.includes('contrasena') ||
    normalizedError.includes('contraseña')
  ) {
    missingFiles.push('.contraseña');
  }

  if (missingFiles.length > 0) {
    return `Falta archivo ${missingFiles.join(', ')}`;
  }

  return errorMessage;
};

const getPasswordLoginReason = (errorMessage: string): string => {
  const normalizedError = normalizeForMatching(errorMessage);

  if (normalizedError.includes('captcha')) {
    return `Captcha: ${errorMessage}`;
  }

  if (normalizedError.includes('password') || normalizedError.includes('contrasena')) {
    return `Falta dato en sistema: ${errorMessage}`;
  }

  return errorMessage;
};

const getSatFailureReason = (errorMessage: string): string => {
  const normalizedError = normalizeForMatching(errorMessage);

  if (
    normalizedError.includes('timeout') ||
    normalizedError.includes('tiempo') ||
    normalizedError.includes('no se pudo cargar') ||
    normalizedError.includes('no cargo') ||
    normalizedError.includes('no carg')
  ) {
    return `Exceso de tiempo o no cargo: ${errorMessage}`;
  }

  if (normalizedError.includes('no se encontro') || normalizedError.includes('no encontro')) {
    return `No encontro el elemento: ${errorMessage}`;
  }

  return errorMessage;
};

const clientUsesPassword = (client: Client): boolean =>
  (client.method ?? []).some((method) => {
    const normalizedMethod = normalizeForMatching(method);
    return normalizedMethod.includes('password') || normalizedMethod.includes('contrasena');
  });

const cleanLogText = (value: string): string => value.replace(/\s+/g, ' ').trim();

const stripAnsiCodes = (value: string): string =>
  value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

const normalizeForMatching = (value: string): string =>
  cleanLogText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const formatDateFolder = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatRunFolder = (date: Date): string => {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
  return `${hours}-${minutes}-${seconds}-${milliseconds}-pid-${process.pid}`;
};

const formatDateTime = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} | ${hours}:${minutes}:${seconds}`;
};
