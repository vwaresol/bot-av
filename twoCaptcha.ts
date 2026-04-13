import 'dotenv/config';
import TwoCaptcha from '@2captcha/captcha-solver';

const TWO_CAPTCHA_API_KEY_ENV = 'TWO_CAPTCHA_API_KEY';

const getTwoCaptchaApiKey = (): string => {
  const apiKey = process.env[TWO_CAPTCHA_API_KEY_ENV]?.trim();

  if (!apiKey) {
    throw new Error(`${TWO_CAPTCHA_API_KEY_ENV} no está definido en el .env`);
  }

  return apiKey;
};

const sanitizeBase64Captcha = (base64: string): string => {
  const sanitized = base64.trim().replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');

  if (!sanitized) {
    throw new Error('El captcha en base64 está vacío');
  }

  return sanitized;
};

export interface SolveBase64CaptchaOptions {
  numeric?: 0 | 1 | 2 | 3 | 4;
  math?: 0 | 1;
  minLen?: number;
  maxLen?: number;
  phrase?: 0 | 1;
  caseSensitive?: 0 | 1;
  language?: 0 | 1 | 2;
  lang?: string;
}

export interface SolvedBase64Captcha {
  text: string;
  raw: unknown;
}

export const createTwoCaptchaSolver = (pollingIntervalMs = 5000): TwoCaptcha.Solver => {
  return new TwoCaptcha.Solver(getTwoCaptchaApiKey(), pollingIntervalMs);
};

export const solveBase64Captcha = async (
  base64: string,
  options: SolveBase64CaptchaOptions = {},
): Promise<SolvedBase64Captcha> => {
  const solver = createTwoCaptchaSolver();
  const body = sanitizeBase64Captcha(base64);

  const result = await solver.imageCaptcha({
    body,
    phrase: options.phrase ?? 0,
    regsense: options.caseSensitive ?? 1,
    numeric: options.numeric ?? 0,
    calc: options.math ?? 0,
    min_len: options.minLen ?? 1,
    max_len: options.maxLen ?? 5,
    language: options.language,
    lang: options.lang,
  });

  return {
    text: result.data,
    raw: result,
  };
};
