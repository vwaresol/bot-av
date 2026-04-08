import 'dotenv/config';
import { chromium, type Locator, type Page } from 'playwright';
import { resolve } from 'node:path';
import { Client, type Document, type Balance, updateBalanceStatus, CustomerCreditStatus } from './api';
import { colors, satPaths } from './constants';
import { readFirstLine } from './utils';

type BalanceStatusResult = {
  status: string;
  lastDate: string | null;
};

const statusMap: Record<string, CustomerCreditStatus> = {
  'SIN ESTADO': CustomerCreditStatus.NO_STATUS,
  'AUTORIZADA TOTAL': CustomerCreditStatus.AUTORIZADA_TOTAL,
  'AUTORIZADA CON COMPENSACION EN OFICIO': CustomerCreditStatus.AUTORIZADA_CON_COMPENSACION_EN_OFICIO,
  'AUTORIZADA CON INCONSISTENCIA EN CUENTA CLABE': CustomerCreditStatus.AUTORIZADA_CON_INCONSISTENCIA_EN_CUENTA_CLABE,
  'AUTORIZADA CON REMANENTE NEGADO': CustomerCreditStatus.AUTORIZADA_CON_REMANENTE_NEGADO,
  'REQUERIDA': CustomerCreditStatus.REQUERIDA,
  'NEGADA': CustomerCreditStatus.NEGADA,
  'PAGADO': CustomerCreditStatus.PAGADO,
  'RECHAZADA': CustomerCreditStatus.RECHAZADA,
  'PAGADA': CustomerCreditStatus.PAGADA,
  'NOTIFICADO': CustomerCreditStatus.NOTIFIED,
  'DESISTIDA': CustomerCreditStatus.GIVEN_UP,
  'EN REVISION POR CREDITOS FISCALES': CustomerCreditStatus.REVIEW_FISCAL_CREDITS,
  'EN PROCESO DE PAGO': CustomerCreditStatus.PAYMENT_IN_PROCESS,
  'EN PROCESO': CustomerCreditStatus.IN_PROCESS,
  'EN PROCESO DE VALIDACION': CustomerCreditStatus.VALIDATION_IN_PROCESS,
};

function mapToCustomerCreditStatus(status: string): CustomerCreditStatus {
  const normalizedStatus = status.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return statusMap[normalizedStatus] || CustomerCreditStatus.NO_STATUS;
}

export const checkStatus = async (client: Client) => {
  // Abre el portal del SAT, autentica al cliente y procesa cada saldo configurado.
  const browser = await chromium.launch({ headless: false });
  try {
    const page = await browser.newPage();

    console.log(`Abriendo página de verificación para cliente...`);
    await page.goto(satPaths.start, {
      waitUntil: 'domcontentloaded'
    });
    const loginPage = await openLoginPage(page);
    await login(loginPage, client);
    await loginPage.waitForLoadState('domcontentloaded');
    await loginPage.locator('xpath=//*[@id="idConsultaDevautisr:tipoSolicitudId"]').waitFor({
      state: 'visible',
    });

    for (const balance of client.balances) {
      await checkBalanceStatus(loginPage, balance);
    }
  } finally {
    await browser.close();
  }
};

const openLoginPage = async (page: Page): Promise<Page> => {
  // Navega desde la página inicial hasta la ventana emergente del login con e.firma.
  const verificationCard = page.locator('xpath=/html/body/div/main/div[2]/section/div/div[3]');
  await humanClick(verificationCard);

  const efirmaLink = page.locator('xpath=//*[@id="body"]/div/main/div[2]/section/div[2]/div/div[1]/div[2]/p/ol/li[1]/a[1]');
  const popupPromise = page.waitForEvent('popup');
  await humanClick(efirmaLink);
  const loginPage = await popupPromise;
  await loginPage.waitForLoadState('domcontentloaded');
  return loginPage;
};

const login = async (page: Page, client: Client) => {
  // Carga certificados, captura la contraseña de la llave y envía el formulario de acceso.
  const rfcInput = page.locator('#rfc');
  await rfcInput.waitFor({ state: 'visible' });
  const eFirmaLogin = page.locator('#buttonFiel');
  await humanClick(eFirmaLogin);
  await page.locator('#txtCertificate').waitFor({ state: 'visible' });
  await page.waitForTimeout(850);

  const certificatePath = resolve(`esign/${client.rfc}/certificado.cer`);
  await setFile(page, '#fileCertificate', certificatePath);

  const keyPath = resolve(`esign/${client.rfc}/llave.key`);
  await setFile(page, '#filePrivateKey', keyPath);

  const passwordPath = resolve(`esign/${client.rfc}/password.txt`);
  const privateKeyPassword = await readFirstLine(passwordPath);
  const privateKeyPasswordInput = page.locator('#privateKeyPassword');
  await privateKeyPasswordInput.waitFor({ state: 'visible' });
  await privateKeyPasswordInput.fill(privateKeyPassword);

  const submitButton = page.locator('#submit');
  await humanClick(submitButton);
};

const checkBalanceStatus = async (page: Page, balance: Balance) => {
  // Selecciona tipo, año y estados disponibles para obtener el estado más reciente del saldo.
  console.log(
    `\n\n${colors.green}Saldo ${balance.year ?? 'N/A'}\nEstado Actual : ${balance.balanceStatus}${colors.reset}`,
  );

  const balanceType = balance.type?.toUpperCase();

  const requestTypeDropdown = page.locator('xpath=//*[@id="idConsultaDevautisr:tipoSolicitudId"]');
  await requestTypeDropdown.waitFor({ state: 'visible' });
  await requestTypeDropdown.scrollIntoViewIfNeeded();
  await page.waitForTimeout(850);
  await humanClick(requestTypeDropdown);
  await waitForPageLoading(page);

  const requestTypePanel = page.locator('xpath=//*[@id="idConsultaDevautisr:tipoSolicitudId_panel"]');
  await requestTypePanel.waitFor({ state: 'visible' });

  console.log({balanceType})
  if (balanceType === 'MANUAL') {
    const manualOption = page.locator(
      'xpath=//*[@id="idConsultaDevautisr:tipoSolicitudId_panel"]/div/ul/li[4]',
    );
    await humanClick(manualOption);
    await waitForPageLoading(page);
  }

  if (balanceType === 'AUTOMATICA' || balanceType === 'AUTOMÁTICA') {
    const automaticOption = page.locator(
      'xpath=//*[@id="idConsultaDevautisr:tipoSolicitudId_panel"]/div/ul/li[6]',
    );
    await humanClick(automaticOption);
    await waitForPageLoading(page);
  } else if (balanceType !== 'MANUAL') {
    throw new Error(`Tipo de saldo no soportado: ${balance.type}`);
  }

  const yearDropdown = page.locator('xpath=//*[@id="idConsultaDevautisr:ejercicioId"]');
  await yearDropdown.waitFor({ state: 'visible' });
  await humanClick(yearDropdown);
  await waitForPageLoading(page);

  const yearPanel = page.locator('xpath=//*[@id="idConsultaDevautisr:ejercicioId_panel"]/div');
  await yearPanel.waitFor({ state: 'visible' });

  const yearOptions = page.locator('xpath=//*[@id="idConsultaDevautisr:ejercicioId_panel"]/div/ul/li');
  await yearOptions.first().waitFor({ state: 'visible' });
  const yearOptionCount = await yearOptions.count();
  const balanceYear = String(balance.year ?? '').trim();

  for (let index = 0; index < yearOptionCount; index += 1) {
    const option = yearOptions.nth(index);
    const optionText = (await option.textContent())?.replace(/\s+/g, ' ').trim();

    if (optionText?.includes(balanceYear)) {
      await option.scrollIntoViewIfNeeded();
      await option.waitFor({ state: 'visible' });
      await humanClick(option);
      await waitForPageLoading(page);
      const availableStatuses = await getAvailableBalanceStatuses(page, balanceType);
      // console.log(
      //   `${colors.blue}Estados disponibles para ${balanceYear}: ${availableStatuses.join(', ')}${colors.reset}`,
      // );

      if (availableStatuses.length === 1 && availableStatuses[0] === 'SIN ESTADO') {
        console.log(`${colors.yellow}Estado detectado: SIN ESTADO${colors.reset}`);
        return;
      }

      const statusResults: BalanceStatusResult[] = [];

      for (const status of availableStatuses) {
        if (status === 'SIN ESTADO') {
          continue;
        }

        const result = await searchStatusAndExtractLastDate(page, status, balanceType);
        statusResults.push(result);
        // console.log(
        //   `${colors.green}${JSON.stringify(result)}${colors.reset}`,
        // );
      }

      // console.log(
      //   `${colors.blue}Resumen de estados ${balanceYear}: ${JSON.stringify(statusResults)}${colors.reset}`,
      // );
      const newestAvailableStatus = getNewestAvailableStatus(statusResults);
      console.log(
        `${colors.yellow}Estado Nuevo: ${newestAvailableStatus ?? 'SIN ESTADO'}${colors.reset}`,
      );

      const statusToUpdate = newestAvailableStatus ?? 'SIN ESTADO';
      const mappedStatus = mapToCustomerCreditStatus(statusToUpdate);
      updateBalanceStatus(balance.id, mappedStatus, satPaths.botUserID);

      return;
    }
  }

  throw new Error(`No se encontró la opción del año ${balanceYear} en el dropdown.`);
};

const getAvailableBalanceStatuses = async (page: Page, balanceType: string): Promise<string[]> => {
  // Lee las opciones del combo de estados y traduce el placeholder a SIN ESTADO cuando aplica.
  const dropdownId = balanceType === 'AUTOMATICA' || balanceType === 'AUTOMÁTICA' ? 'mostrarSolicitudId' : 'mostrarSolicitudIdEdosComps';
  const statusDropdown = page.locator(
    `xpath=//*[@id="idConsultaDevautisr:${dropdownId}"]`,
  );
  await statusDropdown.waitFor({ state: 'visible' });

  const statusOptions = await openStatusDropdownAndReadOptions(page, balanceType);
  const normalizedStatuses = statusOptions.filter((status) => status !== 'Seleccione');

  if (normalizedStatuses.length === 0) {
    return ['SIN ESTADO'];
  }

  return normalizedStatuses;
};

const selectBalanceStatus = async (page: Page, status: string, balanceType: string) => {
  // Abre el combo de estados y deja seleccionado el valor solicitado.
  const dropdownId = balanceType === 'AUTOMATICA' || balanceType === 'AUTOMÁTICA' ? 'mostrarSolicitudId' : 'mostrarSolicitudIdEdosComps';
  const statusDropdown = page.locator(
    `xpath=//*[@id="idConsultaDevautisr:${dropdownId}"]`,
  );
  await statusDropdown.waitFor({ state: 'visible' });
  await humanClick(statusDropdown);

  const panelId = balanceType === 'AUTOMATICA' || balanceType === 'AUTOMÁTICA' ? 'mostrarSolicitudId_panel' : 'mostrarSolicitudIdEdosComps_panel';
  const statusPanel = page.locator(
    `xpath=//*[@id="idConsultaDevautisr:${panelId}"]/div/ul`,
  );
  await statusPanel.waitFor({ state: 'visible' });

  const statusOption = page.locator(
    `xpath=//*[@id="idConsultaDevautisr:${panelId}"]/div/ul/li[@data-label=${toXPathLiteral(status)}]`,
  );
  await statusOption.waitFor({ state: 'visible' });
  await humanClick(statusOption);
  await waitForPageLoading(page);
};

const searchStatusAndExtractLastDate = async (
  page: Page,
  status: string,
  balanceType: string,
): Promise<BalanceStatusResult> => {
  // Ejecuta la búsqueda para un estado específico y devuelve su fecha de presentación más reciente.
  await selectBalanceStatus(page, status, balanceType);
  const searchButton = page.locator('xpath=//*[@id="idConsultaDevautisr:btnBuscar"]');
  await searchButton.waitFor({ state: 'visible' });
  await humanClick(searchButton);
  await waitForPageLoading(page);

  const resultsTable = await findResultsTable(page, balanceType);
  const lastDate = await extractLatestPresentationDate(resultsTable, balanceType);
  return { status, lastDate };
};

const findResultsTable = async (page: Page, balanceType: string): Promise<Locator> => {
  // Ubica la tabla fija de resultados renderizada después de presionar BUSCAR.
  const tableId = balanceType === 'AUTOMATICA' || balanceType === 'AUTOMÁTICA' ? 'dtlDocumentosIsr' : 'dtlDocumentos';
  const resultsTable = page.locator(`xpath=//*[@id="idConsultaDevautisr:${tableId}"]`);
  await resultsTable.waitFor({ state: 'visible' });

  const headerId = balanceType === 'AUTOMATICA' || balanceType === 'AUTOMÁTICA' ? 'dtlDocumentosIsr_head' : 'dtlDocumentos_head';
  const tableHeader = resultsTable.locator(`xpath=.//*[@id="idConsultaDevautisr:${headerId}"]`);
  await tableHeader.waitFor({ state: 'visible' });

  const dataId = balanceType === 'AUTOMATICA' || balanceType === 'AUTOMÁTICA' ? 'dtlDocumentosIsr_data' : 'dtlDocumentos_data';
  const tableBody = resultsTable.locator(`xpath=.//*[@id="idConsultaDevautisr:${dataId}"]`);
  await tableBody.waitFor({ state: 'attached' });

  return resultsTable;
};

const extractLatestPresentationDate = async (table: Locator, balanceType: string): Promise<string | null> => {
  // Recorre todos los renglones de la tabla y conserva la fecha de presentación más reciente.
  const headerId = balanceType === 'AUTOMATICA' || balanceType === 'AUTOMÁTICA' ? 'dtlDocumentosIsr_head' : 'dtlDocumentos_head';
  const headerLocator = table.locator(`xpath=.//*[@id="idConsultaDevautisr:${headerId}"]/tr/th`);
  const headerCount = await headerLocator.count();
  let presentationDateColumnIndex = -1;

  for (let index = 0; index < headerCount; index += 1) {
    const headerText = normalizeText(await headerLocator.nth(index).textContent());

    if (headerText.includes('fecha') && headerText.includes('present')) {
      presentationDateColumnIndex = index;
      break;
    }
  }

  if (presentationDateColumnIndex === -1) {
    throw new Error('No se encontró la columna de fecha de presentación en la tabla de resultados.');
  }

  const dataId = balanceType === 'AUTOMATICA' || balanceType === 'AUTOMÁTICA' ? 'dtlDocumentosIsr_data' : 'dtlDocumentos_data';
  const rows = table.locator(`xpath=.//*[@id="idConsultaDevautisr:${dataId}"]/tr`);
  const rowCount = await rows.count();
  let latestDate: Date | null = null;
  let latestDateText: string | null = null;

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = rows.nth(rowIndex);

    if (!(await row.isVisible().catch(() => false))) {
      continue;
    }

    const cells = row.locator('td');
    const cellCount = await cells.count();

    if (presentationDateColumnIndex >= cellCount) {
      continue;
    }

    const dateText = normalizeDateText(await cells.nth(presentationDateColumnIndex).textContent());
    const parsedDate = parseMxDate(dateText);

    if (!parsedDate) {
      continue;
    }

    if (!latestDate || parsedDate.getTime() > latestDate.getTime()) {
      latestDate = parsedDate;
      latestDateText = dateText;
    }
  }

  return latestDateText;
};

const openStatusDropdownAndReadOptions = async (page: Page, balanceType: string): Promise<string[]> => {
  // Abre el dropdown de estados, captura sus textos visibles y luego lo cierra.
  const dropdownId = balanceType === 'AUTOMATICA' || balanceType === 'AUTOMÁTICA' ? 'mostrarSolicitudId' : 'mostrarSolicitudIdEdosComps';
  const statusDropdown = page.locator(
    `xpath=//*[@id="idConsultaDevautisr:${dropdownId}"]`,
  );
  const panelId = balanceType === 'AUTOMATICA' || balanceType === 'AUTOMÁTICA' ? 'mostrarSolicitudId_panel' : 'mostrarSolicitudIdEdosComps_panel';
  const statusPanel = page.locator(
    `xpath=//*[@id="idConsultaDevautisr:${panelId}"]/div/ul`,
  );
  const statusOptions = page.locator(
    `xpath=//*[@id="idConsultaDevautisr:${panelId}"]/div/ul/li`,
  );

  await statusDropdown.waitFor({ state: 'visible' });
  await humanClick(statusDropdown);
  await statusPanel.waitFor({ state: 'visible' });
  await statusOptions.first().waitFor({ state: 'visible' });

  const optionCount = await statusOptions.count();
  const options: string[] = [];

  for (let index = 0; index < optionCount; index += 1) {
    const optionText = (await statusOptions.nth(index).textContent())?.replace(/\s+/g, ' ').trim();

    if (optionText) {
      options.push(optionText);
    }
  }

  await humanClick(statusDropdown);
  return options;
};

const toXPathLiteral = (value: string): string => {
  // Escapa textos dinámicos para poder usarlos con seguridad dentro de expresiones XPath.
  if (!value.includes("'")) {
    return `'${value}'`;
  }

  if (!value.includes('"')) {
    return `"${value}"`;
  }

  const parts = value.split("'");
  return `concat('${parts.join(`', "'", '`)}')`;
};

const normalizeText = (value: string | null | undefined): string =>
  // Normaliza textos para comparaciones tolerantes a espacios y mayúsculas.
  (value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const normalizeDateText = (value: string | null | undefined): string =>
  // Uniforma el separador de fechas antes de intentar parsearlas.
  (value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\//g, '-');

const parseMxDate = (value: string): Date | null => {
  // Convierte fechas en formato dd-mm-yyyy a objetos Date para poder compararlas.
  const match = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);

  if (!match) {
    return null;
  }

  const [, day, month, year] = match;
  const parsedDate = new Date(Number(year), Number(month) - 1, Number(day));

  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  return parsedDate;
};

const getNewestAvailableStatus = (results: BalanceStatusResult[]): string | null => {
  // Elige el estado cuyo resultado tenga la fecha válida más reciente.
  let newestResult: BalanceStatusResult | null = null;
  let newestDate: Date | null = null;

  for (const result of results) {
    if (!result.lastDate) {
      continue;
    }

    const parsedDate = parseMxDate(normalizeDateText(result.lastDate));

    if (!parsedDate) {
      continue;
    }

    if (!newestDate || parsedDate.getTime() > newestDate.getTime()) {
      newestDate = parsedDate;
      newestResult = result;
    }
  }

  return newestResult?.status ?? null;
};

const humanClick = async (locator: Locator) => {
  // Simula un click con pequeños movimientos y pausas para evitar interacciones instantáneas.
  await locator.waitFor({ state: 'visible' });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();

  if (box) {
    // Apunta al centro aproximado del elemento con una pequeña variación
    // para evitar movimientos idénticos en cada ejecución.
    const targetX = box.x + box.width / 2 + (Math.random() * 10 - 5);
    const targetY = box.y + box.height / 2 + (Math.random() * 10 - 5);

    // Mueve el mouse en varios pasos para simular una trayectoria humana.
    await locator.page().mouse.move(targetX, targetY, {
      steps: 12 + Math.floor(Math.random() * 10),
    });
  }

  // Deja una pausa breve antes del click para no interactuar de forma instantánea.
  await locator.page().waitForTimeout(300 + Math.floor(Math.random() * 500));
  await locator.click({ delay: 80 + Math.floor(Math.random() * 120) });
};

const waitForPageLoading = async (page: Page) => {
  // Espera el overlay de carga de la vista cuando aparece después de una acción AJAX.
  const loadingOverlay = page.locator('xpath=//*[@id="j_idt9"]').first();

  try {
    await loadingOverlay.waitFor({ state: 'visible', timeout: 2000 });
    await loadingOverlay.waitFor({ state: 'hidden', timeout: 2000 });
    return;
  } catch {
    // Si en 2s no aparece, asumimos que la vista ya estaba lista.
  }
};

const setFile = async (page: Page, selector: string, filePath: string) => {
  // Sube un archivo a un input y valida que el nombre haya quedado cargado en el DOM.
  const input = page.locator(selector).first();
  await input.waitFor({ state: 'attached' });
  await page.waitForTimeout(425);
  await input.setInputFiles(filePath);
  await expectInputFile(page, selector, filePath);
  await page.waitForTimeout(425);
};

const expectInputFile = async (page: Page, selector: string, filePath: string) => {
  // Verifica que el input contenga exactamente el archivo esperado antes de continuar.
  const expectedFileName = filePath.split('/').pop() ?? filePath;

  await page.waitForFunction(
    ([inputSelector, expectedName]) => {
      const inputElement = document.querySelector(inputSelector) as HTMLInputElement | null;
      return inputElement?.files?.[0]?.name === expectedName;
    },
    [selector, expectedFileName],
  );
};
