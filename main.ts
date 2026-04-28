import 'dotenv/config';
import { checkStatus } from './checkStatus.js';
import { colors } from './constants.js';
import { Client, fetchClients, fetchClient } from './api.js';
import { prepareFiles } from './documents.js';
import { ensureLogDirectory, logError, logSummary } from './utils.js';

const timeBetweenChecks = parseInt(process.env.TIME_BETWEEN_CHECKS_MS || '1250', 10);

const validateEnvironment = () => {
  const apiUrl = process.env.API_URL;
  const cdnUrl = process.env.CDN_URL;
  
  if (!apiUrl) {
    throw new Error('API_URL no está definido en el .env');
  }
  if (!cdnUrl) {
    throw new Error('CDN_URL no está definido en el .env');
  }
  if (!timeBetweenChecks || isNaN(timeBetweenChecks)) {
    throw new Error('TIME_BETWEEN_CHECKS_MS no está definido o no es un número válido en el .env');
  }
};

const main = async (scriptStart: Date) => {
  let successfulClients = 0;
  let failedClients = 0;
  let totalClients = 0;
  let fatalError: unknown = null;

  try {
    await ensureLogDirectory(scriptStart);
    validateEnvironment();
    console.log(`${colors.blue}Obteniendo lista de clientes...${colors.reset}`);
    const clients = await fetchClients() as Client[];
    console.log(`${colors.green}Encontrados ${clients.length} clientes.${colors.reset}`);
    totalClients = clients.length;

    for (let i = 0; i < totalClients; i++) {
      const client = clients[i];
      console.log(`${colors.blue}Verificando cliente ${i + 1} de ${totalClients}${colors.reset}`);
      const clientReviewStart = Date.now();
      //const client = await fetchClient('ffb30966-b9b2-4da7-90eb-3ec3655d5570') as Client;
      console.log(`${colors.yellow}\nVerificando RFC: ${client.rfc} - (ID: ${client.id})${colors.reset}`);
      // Delay entre verificaciones
      await new Promise(resolve => setTimeout(resolve, timeBetweenChecks));
      try {
        await prepareFiles(client);
        await checkStatus(client);
        const clientReviewDuration = formatDuration(Date.now() - clientReviewStart);
        console.log(
          `${colors.blue}Tiempo total de revisión: ${clientReviewDuration}${colors.reset}`,
        );
        console.log(`${colors.green}Verificación completada \n${colors.reset}`);
        successfulClients += 1;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(`${colors.red}Error para cliente ${client.rfc}: ${errorMessage}${colors.reset}`);
        failedClients += 1;
        await logError(client, errorMessage, scriptStart);
        continue;
      }
      //break;
    }

    console.log(`${colors.green}Todas las verificaciones completadas.${colors.reset}`);
  } catch (error) {
    fatalError = error;
    console.error(`${colors.red}Error en el proceso principal:${colors.reset}`, error);
  } finally {
    const scriptEnd = new Date();
    await logSummary(
      {
        successfulClients,
        failedClients,
        totalClients,
        startDate: scriptStart,
        endDate: scriptEnd,
        durationMs: scriptEnd.getTime() - scriptStart.getTime(),
      },
      scriptStart,
    );
  }

  if (fatalError) {
    process.exit(1);
  }
};

const formatDuration = (durationMs: number): string => {
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours > 0 ? `${hours}h` : null, minutes > 0 ? `${minutes}m` : null, `${seconds}s`]
    .filter(Boolean)
    .join(' ');
};

(async () => {
  const scriptStart = new Date();
  await main(scriptStart);
  const scriptDuration = Date.now() - scriptStart.getTime();
  console.log(`${colors.green}Tiempo total del script: ${formatDuration(scriptDuration)}${colors.reset}`);
})();
