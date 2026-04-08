import { readFile, appendFile } from 'node:fs/promises';

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
/**
 * Logs an error to a file by saving only the RFC.
 * @param rfc - The RFC of the client.
 * @param errorMessage - The error message (not saved in the file).
 */
export const logError = async (rfc: string, errorMessage: string): Promise<void> => {
  const logEntry = `${rfc}\n`;
  try {
    await appendFile('error.log', logEntry, 'utf-8');
  } catch (logError) {
    console.error('Error al escribir en el log:', logError);
  }
};