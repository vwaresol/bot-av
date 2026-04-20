import 'dotenv/config';
import { chromium, type Locator, type Page } from 'playwright';
import { resolve } from 'node:path';
import { Client, type Document, type Balance, updateBalanceStatus, CustomerCreditStatus } from './api';
import { colors, satPaths } from './constants';
import { solveBase64Captcha } from './twoCaptcha.js';
import { readFirstLine } from './utils';

type BalanceStatusResult = {
  status: string;
  lastDate: string | null;
};

type SatContext = Pick<Page, 'locator'>;

const postLoginReadyTimeoutMs = 90_000;
const postLoginPollIntervalMs = 500;
const submitReadyTimeoutMs = 30_000;
const loginPageLoadTimeoutMs = 15_000;
const postLoginChromeErrorGraceMs = 10_000;

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
  'INCONSISTENTE EN CUENTA CLABE DECLARADA': CustomerCreditStatus.INCONSISTENTE_EN_CUENTA_CLABE_DECLARADA
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
    const usesPasswordLogin = clientUsesPassword(client);

    if (usesPasswordLogin) {
      console.log('Iniciando sesion con contraseña');
      try {
        await LoginWithPassword(loginPage, client);
        await loginPage.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
        await ensurePostLoginPageIsValid(loginPage);
      } catch (error) {
        throw new Error(`Error de captcha en login SAT: ${getErrorMessage(error)}`);
      }
    } else {
      console.log('Iniciando sesion con certificados');
      await login(loginPage, client);
      await loginPage.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
      await ensurePostLoginPageIsValid(loginPage);
    }

    const satContext = await getSatContext(loginPage);

    for (const balance of client.balances) {
      await checkBalanceStatus(satContext, balance);
    }
  } finally {
    await browser.close();
  }
};

const openLoginPage = async (page: Page): Promise<Page> => {
  // Navega desde la página inicial hasta la opción de login correspondiente para el cliente.
  const verificationCard = page.locator('xpath=/html/body/div/main/div[2]/section/div/div[3]');
  await humanClick(verificationCard);

  const efirmaLink = page.locator('xpath=//*[@id="body"]/div/main/div[2]/section/div[2]/div/div[1]/div[2]/p/ol/li[1]/a[1]');
  const popupPromise = page.waitForEvent('popup');
  await humanClick(efirmaLink);
  const loginPage = await popupPromise;
  try {
    await loginPage.waitForLoadState('domcontentloaded', { timeout: loginPageLoadTimeoutMs });
  } catch (error) {
    throw new Error(`No se pudo cargar la pantalla de login SAT: ${getErrorMessage(error)}`);
  }
  await ensureChromeErrorPageWasNotLoaded(loginPage, 'cargar pantalla de login SAT');
  return loginPage;
};

const login = async (page: Page, client: Client) => {
  // Carga certificados, captura la contraseña de la llave y envía el formulario de acceso.
  const loginContext = await getSatContext(page);
  const rfcInput = loginContext.locator('#rfc');
  await rfcInput.waitFor({ state: 'visible' });
  const eFirmaLogin = loginContext.locator('#buttonFiel');
  await humanClick(eFirmaLogin);
  await loginContext.locator('#txtCertificate').waitFor({ state: 'visible' });
  await page.waitForTimeout(850);

  const certificatePath = resolve(`esign/${client.rfc}/certificado.cer`);
  await setFile(loginContext.locator('#fileCertificate').first(), certificatePath);
  await ensureLoginFormHasNoError(loginContext);

  const keyPath = resolve(`esign/${client.rfc}/llave.key`);
  await setFile(loginContext.locator('#filePrivateKey').first(), keyPath);
  await ensureLoginFormHasNoError(loginContext);

  const passwordPath = resolve(`esign/${client.rfc}/password.txt`);
  const privateKeyPassword = await readFirstLine(passwordPath);
  const privateKeyPasswordInput = loginContext.locator('#privateKeyPassword');
  await privateKeyPasswordInput.waitFor({ state: 'visible' });
  await privateKeyPasswordInput.fill(privateKeyPassword);
  await ensureLoginFormHasNoError(loginContext);

  const submitButton = loginContext.locator('#submit');
  await ensureLoginCanProceed(loginContext, submitButton, page);
  await humanClick(submitButton);
};

const LoginWithPassword = async (page: Page, client: Client) => {
  // Captura RFC, contraseña y captcha del cliente antes de enviar el formulario.
  if (!client.password) {
    throw new Error(`El cliente ${client.rfc} no tiene password configurado para login SAT.`);
  }

  const loginContext = await getSatContext(page);
  const rfcInput = loginContext.locator('#rfc');
  await rfcInput.waitFor({ state: 'visible' });
  await rfcInput.fill(client.rfc);
  await ensureLoginFormHasNoError(loginContext);

  const passwordInput = loginContext.locator('#password');
  await passwordInput.waitFor({ state: 'visible' });
  await passwordInput.fill(client.password);
  await ensureLoginFormHasNoError(loginContext);

  const captchaText = await solveLoginCaptcha(loginContext);
  const captchaInput = loginContext.locator('#userCaptcha');
  await captchaInput.waitFor({ state: 'visible' });
  await captchaInput.fill(captchaText);
  await ensureLoginFormHasNoError(loginContext);

  const submitButton = loginContext.locator('#submit');
  await ensureLoginCanProceed(loginContext, submitButton, page);
  await humanClick(submitButton);
};

const clientUsesPassword = (client: Client): boolean =>
  (client.method ?? []).some((method) => {
    const normalizedMethod = normalizeText(method);
    return normalizedMethod.includes('password') || normalizedMethod.includes('contrasena');
  });

const solveLoginCaptcha = async (loginContext: SatContext): Promise<string> => {
  try {
    const captchaImage = loginContext.locator('#divCaptcha img').first();
    await captchaImage.waitFor({ state: 'visible' });

    const captchaSrc = await captchaImage.getAttribute('src');

    if (!captchaSrc) {
      throw new Error('No se encontró la imagen del captcha de login SAT.');
    }

    const solvedCaptcha = await solveBase64Captcha(captchaSrc, {
      caseSensitive: 1,
      minLen: 4,
      maxLen: 16,
    });

    return solvedCaptcha.text.trim().toUpperCase();
  } catch (error) {
    throw new Error(`No se pudo resolver el captcha SAT: ${getErrorMessage(error)}`);
  }
};

const getSatContext = async (page: Page): Promise<SatContext> => {
  const loginIframe = page.locator('#iframetoload').first();

  if (await loginIframe.count()) {
    await loginIframe.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    return page.frameLocator('#iframetoload');
  }

  return page;
};

const ensureLoginCanProceed = async (loginContext: SatContext, submitButton: Locator, page: Page) => {
  // Espera a que el botón Enviar se habilite o detecta el mensaje de error del formulario para abortar el cliente.
  const deadline = Date.now() + submitReadyTimeoutMs;

  while (Date.now() < deadline) {
    await ensureLoginFormHasNoError(loginContext);

    if (await isLocatorEnabled(submitButton)) {
      return;
    }

    await page.waitForTimeout(postLoginPollIntervalMs);
  }

  await ensureLoginFormHasNoError(loginContext);

  throw new Error('El boton Enviar no se habilito despues de 30 segundos.');
};

const ensureLoginFormHasNoError = async (loginContext: SatContext): Promise<void> => {
  const errorContainer = loginContext.locator('xpath=//*[@id="divError"]').first();
  const errorMessage = await getLoginErrorMessage(errorContainer);

  if (errorMessage) {
    throw new Error(`Error en login SAT: ${errorMessage}`);
  }
};

const ensurePostLoginPageIsValid = async (page: Page) => {
  // Tras enviar el login, espera a que cargue la vista válida o detecta la pantalla WHITE para abortar el cliente.
  const satContext = await getSatContext(page);
  const requestTypeDropdown = satContext.locator('xpath=//*[@id="idConsultaDevautisr:tipoSolicitudId"]');
  const whiteHeader = page.locator('xpath=/html/body/h1').first();
  const deadline = Date.now() + postLoginReadyTimeoutMs;
  let chromeErrorFirstSeenAt: number | null = null;
  let lastChromeError: string | null = null;

  while (Date.now() < deadline) {
    const chromeError = await getChromeErrorPageMessage(page);

    if (chromeError) {
      chromeErrorFirstSeenAt ??= Date.now();
      lastChromeError = chromeError;

      if (Date.now() - chromeErrorFirstSeenAt >= postLoginChromeErrorGraceMs) {
        throw new Error(`Error de Chrome después del login SAT: ${chromeError}`);
      }
    } else {
      chromeErrorFirstSeenAt = null;
      lastChromeError = null;
    }

    if (await isWhiteHeaderVisible(whiteHeader)) {
      throw new Error('Pantalla WHITE detectada después del login.');
    }

    if (await requestTypeDropdown.isVisible().catch(() => false)) {
      return;
    }

    await page.waitForTimeout(postLoginPollIntervalMs);
  }

  if (lastChromeError) {
    throw new Error(`Error de Chrome después del login SAT: ${lastChromeError}`);
  }

  if (await isWhiteHeaderVisible(whiteHeader)) {
    throw new Error('Pantalla WHITE detectada después del login.');
  }

  await ensureChromeErrorPageWasNotLoaded(page, 'después del login SAT');
  await requestTypeDropdown.waitFor({ state: 'visible', timeout: 1_000 });
};

const ensureChromeErrorPageWasNotLoaded = async (page: Page, context: string): Promise<void> => {
  const chromeError = await getChromeErrorPageMessage(page);

  if (chromeError) {
    throw new Error(`Error de Chrome al ${context}: ${chromeError}`);
  }
};

const getChromeErrorPageMessage = async (page: Page): Promise<string | null> => {
  const url = page.url();
  const title = normalizeText(await page.title().catch(() => ''));
  const bodyText = normalizeText(await page.locator('body').innerText({ timeout: 1_000 }).catch(() => ''));
  const errorCodeMatch = bodyText.match(/err_[a-z0-9_]+/i);
  const hasChromeErrorUrl = url.startsWith('chrome-error://');
  const isChromeErrorPage =
    hasChromeErrorUrl ||
    Boolean(errorCodeMatch) ||
    title.includes('this site can') ||
    bodyText.includes('this site can') ||
    bodyText.includes('no se puede acceder a este sitio') ||
    bodyText.includes('no se ha podido acceder a este sitio');

  if (!isChromeErrorPage) {
    return null;
  }

  const errorCode = errorCodeMatch?.[0].toUpperCase();

  if (errorCode) {
    return `${errorCode} (${url})`;
  }

  return `Se cargo una pagina de error del navegador. URL: ${url}. Titulo: ${title || 'sin titulo'}`;
};

const isWhiteHeaderVisible = async (header: Locator): Promise<boolean> => {
  const isVisible = await header.isVisible().catch(() => false);

  if (!isVisible) {
    return false;
  }

  const headerText = normalizeText(await header.textContent());
  return headerText.includes('whitelabel error page') || headerText === 'white';
};

const isLocatorEnabled = async (locator: Locator): Promise<boolean> =>
  await locator.isEnabled().catch(() => false);

const getLoginErrorMessage = async (errorContainer: Locator): Promise<string | null> => {
  const isVisible = await errorContainer.isVisible().catch(() => false);

  if (!isVisible) {
    return null;
  }

  const errorText = (await errorContainer.textContent())?.replace(/\s+/g, ' ').trim();
  return errorText || 'Se detecto un error en divError.';
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const checkBalanceStatus = async (satContext: SatContext, balance: Balance) => {
  // Selecciona tipo, año y estados disponibles para obtener el estado más reciente del saldo.
  console.log(
    `\n\n${colors.green}Saldo ${balance.year ?? 'N/A'}\nEstado Actual : ${balance.balanceStatus}${colors.reset}`,
  );

  const balanceType = balance.type?.toUpperCase();

  const requestTypeDropdown = satContext.locator('xpath=//*[@id="idConsultaDevautisr:tipoSolicitudId"]');
  await requestTypeDropdown.waitFor({ state: 'visible' });
  await requestTypeDropdown.scrollIntoViewIfNeeded();
  await requestTypeDropdown.page().waitForTimeout(850);
  await humanClick(requestTypeDropdown);
  await waitForPageLoading(satContext);

  const requestTypePanel = satContext.locator('xpath=//*[@id="idConsultaDevautisr:tipoSolicitudId_panel"]');
  await requestTypePanel.waitFor({ state: 'visible' });

  console.log({balanceType})
  if (balanceType === 'MANUAL') {
    const manualOption = satContext.locator(
      'xpath=//*[@id="idConsultaDevautisr:tipoSolicitudId_panel"]/div/ul/li[4]',
    );
    await humanClick(manualOption);
    await waitForPageLoading(satContext);
  }

  if (balanceType === 'AUTOMATICA' || balanceType === 'AUTOMÁTICA') {
    const automaticOption = satContext.locator(
      'xpath=//*[@id="idConsultaDevautisr:tipoSolicitudId_panel"]/div/ul/li[6]',
    );
    await humanClick(automaticOption);
    await waitForPageLoading(satContext);
  } else if (balanceType !== 'MANUAL') {
    throw new Error(`Tipo de saldo no soportado: ${balance.type}`);
  }

  const yearDropdown = satContext.locator('xpath=//*[@id="idConsultaDevautisr:ejercicioId"]');
  await yearDropdown.waitFor({ state: 'visible' });
  await humanClick(yearDropdown);
  await waitForPageLoading(satContext);

  const yearPanel = satContext.locator('xpath=//*[@id="idConsultaDevautisr:ejercicioId_panel"]/div');
  await yearPanel.waitFor({ state: 'visible' });

  const yearOptions = satContext.locator('xpath=//*[@id="idConsultaDevautisr:ejercicioId_panel"]/div/ul/li');
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
      await waitForPageLoading(satContext);
      const availableStatuses = await getAvailableBalanceStatuses(satContext, balanceType);
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

        const result = await searchStatusAndExtractLastDate(satContext, status, balanceType);
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

const getAvailableBalanceStatuses = async (satContext: SatContext, balanceType: string): Promise<string[]> => {
  // Lee las opciones del combo de estados y traduce el placeholder a SIN ESTADO cuando aplica.
  const dropdownId = balanceType === 'AUTOMATICA' || balanceType === 'AUTOMÁTICA' ? 'mostrarSolicitudId' : 'mostrarSolicitudIdEdosComps';
  const statusDropdown = satContext.locator(
    `xpath=//*[@id="idConsultaDevautisr:${dropdownId}"]`,
  );
  await statusDropdown.waitFor({ state: 'visible' });

  const statusOptions = await openStatusDropdownAndReadOptions(satContext, balanceType);
  const normalizedStatuses = statusOptions.filter((status) => status !== 'Seleccione');

  if (normalizedStatuses.length === 0) {
    return ['SIN ESTADO'];
  }

  return normalizedStatuses;
};

const selectBalanceStatus = async (satContext: SatContext, status: string, balanceType: string) => {
  // Abre el combo de estados y deja seleccionado el valor solicitado.
  const dropdownId = balanceType === 'AUTOMATICA' || balanceType === 'AUTOMÁTICA' ? 'mostrarSolicitudId' : 'mostrarSolicitudIdEdosComps';
  const statusDropdown = satContext.locator(
    `xpath=//*[@id="idConsultaDevautisr:${dropdownId}"]`,
  );
  await statusDropdown.waitFor({ state: 'visible' });
  await humanClick(statusDropdown);

  const panelId = balanceType === 'AUTOMATICA' || balanceType === 'AUTOMÁTICA' ? 'mostrarSolicitudId_panel' : 'mostrarSolicitudIdEdosComps_panel';
  const statusPanel = satContext.locator(
    `xpath=//*[@id="idConsultaDevautisr:${panelId}"]/div/ul`,
  );
  await statusPanel.waitFor({ state: 'visible' });

  const statusOption = satContext.locator(
    `xpath=//*[@id="idConsultaDevautisr:${panelId}"]/div/ul/li[@data-label=${toXPathLiteral(status)}]`,
  );
  await statusOption.waitFor({ state: 'visible' });
  await humanClick(statusOption);
  await waitForPageLoading(satContext);
};

const searchStatusAndExtractLastDate = async (
  satContext: SatContext,
  status: string,
  balanceType: string,
): Promise<BalanceStatusResult> => {
  // Ejecuta la búsqueda para un estado específico y devuelve su fecha de presentación más reciente.
  await selectBalanceStatus(satContext, status, balanceType);
  const searchButton = satContext.locator('xpath=//*[@id="idConsultaDevautisr:btnBuscar"]');
  await searchButton.waitFor({ state: 'visible' });
  await humanClick(searchButton);
  await waitForPageLoading(satContext);

  const resultsTable = await findResultsTable(satContext, balanceType);
  const lastDate = await extractLatestPresentationDate(resultsTable, balanceType);
  return { status, lastDate };
};

const findResultsTable = async (satContext: SatContext, balanceType: string): Promise<Locator> => {
  // Ubica la tabla fija de resultados renderizada después de presionar BUSCAR.
  const tableId = balanceType === 'AUTOMATICA' || balanceType === 'AUTOMÁTICA' ? 'dtlDocumentosIsr' : 'dtlDocumentos';
  const resultsTable = satContext.locator(`xpath=//*[@id="idConsultaDevautisr:${tableId}"]`);
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

const openStatusDropdownAndReadOptions = async (satContext: SatContext, balanceType: string): Promise<string[]> => {
  // Abre el dropdown de estados, captura sus textos visibles y luego lo cierra.
  const dropdownId = balanceType === 'AUTOMATICA' || balanceType === 'AUTOMÁTICA' ? 'mostrarSolicitudId' : 'mostrarSolicitudIdEdosComps';
  const statusDropdown = satContext.locator(
    `xpath=//*[@id="idConsultaDevautisr:${dropdownId}"]`,
  );
  const panelId = balanceType === 'AUTOMATICA' || balanceType === 'AUTOMÁTICA' ? 'mostrarSolicitudId_panel' : 'mostrarSolicitudIdEdosComps_panel';
  const statusPanel = satContext.locator(
    `xpath=//*[@id="idConsultaDevautisr:${panelId}"]/div/ul`,
  );
  const statusOptions = satContext.locator(
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

const waitForPageLoading = async (satContext: SatContext) => {
  // Espera el overlay de carga de la vista cuando aparece después de una acción AJAX.
  const loadingOverlay = satContext.locator('xpath=//*[@id="j_idt9"]').first();

  try {
    await loadingOverlay.waitFor({ state: 'visible', timeout: 2000 });
    await loadingOverlay.waitFor({ state: 'hidden', timeout: 2000 });
    return;
  } catch {
    // Si en 2s no aparece, asumimos que la vista ya estaba lista.
  }
};

const setFile = async (input: Locator, filePath: string) => {
  // Sube un archivo a un input y valida que el nombre haya quedado cargado en el DOM.
  await input.waitFor({ state: 'attached' });
  await input.page().waitForTimeout(425);
  await input.setInputFiles(filePath);
  await expectInputFile(input, filePath);
  await input.page().waitForTimeout(425);
};

const expectInputFile = async (input: Locator, filePath: string) => {
  // Verifica que el input contenga exactamente el archivo esperado antes de continuar.
  const expectedFileName = filePath.split('/').pop() ?? filePath;

  const uploadedFileName = await input.evaluate((inputElement) =>
    (inputElement as HTMLInputElement).files?.[0]?.name ?? null,
  );

  if (uploadedFileName !== expectedFileName) {
    throw new Error(`No se pudo validar la carga del archivo ${expectedFileName}.`);
  }
};
