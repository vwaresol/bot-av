import 'dotenv/config';
import { colors } from './constants.js';

const apiUrl = process.env.API_URL;
const cdnUrl = process.env.CDN_URL;

export interface Client {
  id: string;
  rfc: string;
  name: string;
  method?: string[];
  password?: string | null;
  documents: Document[];
  balances: Balance[];
}

export interface Document {
  id: string;
  name: string;
  status: string;
  path: string;
  type: string;
}

export interface Balance {
  id: string;
  year: string;
  balanceStatus: string;
  type: string;
}

export enum CustomerReturnTypeOptions {
  MANUAL = 'MANUAL',
  AUTOMATICA = 'AUTOMÁTICA',
}

export enum ErrorTypeEnum {
  ARCHIVOS = 'ARCHIVOS',
  LOGIN_EFIRMA = 'LOGIN EFIRMA',
  LOGIN_CONTRASEÑA = 'LOGIN CONTRASEÑA',
  SAT = 'SAT',
}

type CreateLogPayload = {
  returnType: CustomerReturnTypeOptions;
  errorType: ErrorTypeEnum;
  customerId: string;
  balanceId: string;
  description: string;
};

export const fetchClients = async (): Promise<Client[]> => {
  const url = `${apiUrl}/customer/to-process/balances-esign`;
  console.log(`${colors.blue}Obteniendo clientes desde '${url}' ...${colors.reset}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Error al obtener clientes: ${response.statusText}`);
  }

  const data = await response.json();
  return data;
};

export const fetchClient = async (id: string): Promise<Client> => {
  const url = `${apiUrl}/customer/${id}/get`;
  console.log(`${colors.blue}Obteniendo cliente desde '${url}' ...${colors.reset}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Error al obtener cliente: ${response.statusText}`);
  }

  const data = await response.json();
  return data;
};

export const fetchFileFromCDN = async (name: string): Promise<Buffer> => {
  const url = `${cdnUrl}/AV/esign/${name}`;
  console.log(`${colors.yellow}Descargando archivo desde CDN: '${url}' ...${colors.reset}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Error al descargar archivo de CDN: ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

export const createLogsForClientError = async (
  client: Client,
  errorType: ErrorTypeEnum,
  description: string,
): Promise<void> => {
  if (!client.balances.length) {
    console.warn(`${colors.yellow}No se registró log remoto para ${client.rfc}: el cliente no tiene saldos.${colors.reset}`);
    return;
  }

  for (const balance of client.balances) {
    try {
      await createLog({
        customerId: client.id,
        balanceId: balance.id,
        returnType: getBalanceReturnType(balance),
        errorType,
        description,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `${colors.red}Error registrando log remoto para ${client.rfc} / saldo ${balance.id}: ${errorMessage}${colors.reset}`,
      );
    }
  }
};

const createLog = async (payload: CreateLogPayload): Promise<void> => {
  const url = `${apiUrl}/logs`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    throw new Error(`Error al crear log: ${response.status} ${response.statusText}${responseBody ? ` - ${responseBody}` : ''}`);
  }
};

const getBalanceReturnType = (balance: Balance): CustomerReturnTypeOptions => {
  const normalizedType = balance.type
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  if (normalizedType === 'AUTOMATICA') {
    return CustomerReturnTypeOptions.AUTOMATICA;
  }

  return CustomerReturnTypeOptions.MANUAL;
};

export enum CustomerCreditStatus {
  NO_STATUS = 'SIN ESTADO',
  AUTORIZADA_TOTAL = 'AUTORIZADA TOTAL',
  AUTORIZADA_CON_COMPENSACION_EN_OFICIO = 'AUTORIZADA CON COMPENSACION EN OFICIO',
  AUTORIZADA_CON_INCONSISTENCIA_EN_CUENTA_CLABE = 'AUTORIZADA CON INCONSISTENCIA EN CUENTA CLABE',
  AUTORIZADA_CON_REMANENTE_NEGADO = 'AUTORIZADA CON REMANENTE NEGADO',
  REQUERIDA = 'REQUERIDA',
  NEGADA = 'NEGADA',
  PAGADO = 'PAGADO',
  RECHAZADA = 'RECHAZADA',
  PAGADA = 'PAGADA',
  NOTIFIED = 'NOTIFICADO',
  GIVEN_UP = 'DESISTIDA',
  REVIEW_FISCAL_CREDITS = 'EN REVISION POR CREDITOS FISCALES',
  PAYMENT_IN_PROCESS = 'EN PROCESO DE PAGO',
  IN_PROCESS = 'EN PROCESO',
  VALIDATION_IN_PROCESS = 'EN PROCESO DE VALIDACION',
  INCONSISTENTE_EN_CUENTA_CLABE_DECLARADA = 'INCONSISTENTE EN CUENTA CLABE DECLARADA'
}

export const updateBalanceStatus = async (balanceId: string, status: CustomerCreditStatus, userId: string): Promise<void> => {
  const url = `${apiUrl}/balance/${balanceId}/status`;
  console.log(`${colors.blue}Actualizando balance status en '${url}' ...${colors.reset}`);
  console.log(`${colors.green}Status enviado: '${status}'${colors.reset}`);
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      balanceStatus: status,
      userId,
    }),
  });
  if (!response.ok) {
    throw new Error(`Error al actualizar balance status: ${response.statusText}`);
  }
};
