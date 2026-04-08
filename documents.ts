import { mkdir } from 'node:fs/promises';
import { colors } from './constants.js';
import { fetchFileFromCDN } from './api.js';
import type { Client } from './api.js';
import { Extract } from 'unzipper';

export const prepareFiles = async (client: Client): Promise<void> => {
  const eSignDoc = client.documents.find(doc => doc.type === 'eSign');
  
  if (!eSignDoc) {
    console.log(`${colors.yellow}No se encontró documento eSign para cliente ${client.rfc}${colors.reset}`);
    return;
  }

  try {
    // Descargar archivo ZIP del CDN
    const zipBuffer = await fetchFileFromCDN(eSignDoc.name);
    
    // Crear carpeta de destino
    const dirPath = `esign/${client.rfc}`;
    await mkdir(dirPath, { recursive: true });
    
    // Extraer archivos del ZIP
    await extractAndSaveFiles(zipBuffer, dirPath);
    
    console.log(`${colors.blue}Archivos extraídos y guardados en: ${dirPath}${colors.reset}`);
  } catch (error) {
    throw new Error(`Error preparando archivos para cliente ${client.rfc}: ${(error as Error).message}`);
  }
};

const extractAndSaveFiles = async (zipBuffer: Buffer, destDir: string): Promise<void> => {
  const { Readable } = await import('node:stream');
  const { readdir, rename } = await import('node:fs/promises');
  
  return new Promise((resolve, reject) => {
    const readable = Readable.from(zipBuffer);
    
    readable
      .pipe(Extract({ path: destDir }))
      .on('error', reject)
      .on('close', async () => {
        try {
          console.log(`${colors.blue}Extracción completada, procesando archivos...${colors.reset}`);
          
          // Leer archivos en el directorio
          const files = await readdir(destDir);
          
          for (const fileName of files) {
            if (fileName === '.' || fileName === '..') continue;
            
            console.log(`${colors.blue}Procesando: ${fileName}${colors.reset}`);
            
            let newFileName = '';
            if (fileName.endsWith('.key')) {
              newFileName = 'llave.key';
            } else if (fileName.endsWith('.cer')) {
              newFileName = 'certificado.cer';
            } else if (fileName.endsWith('.txt')) {
              newFileName = 'password.txt';
            } else {
              continue;
            }
            
            if (newFileName !== fileName) {
              const oldPath = `${destDir}/${fileName}`;
              const newPath = `${destDir}/${newFileName}`;
              await rename(oldPath, newPath);
            }
          }
          
          resolve();
        } catch (error) {
          reject(error);
        }
      });
  });
};
