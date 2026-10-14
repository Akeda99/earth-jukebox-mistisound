import es from './es.json';
import en from './en.json';

const dictionaries = { es, en };

const STORAGE_KEY = 'earth-jukebox-lang';
const DEFAULT_LANG = 'es';

export function getStoredLang() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    // Un valor guardado invalido (version anterior, manipulacion manual,
    // etc.) no debe romper la app: se ignora y se vuelve al idioma por
    // defecto en vez de pasarlo sin validar a t().
    return availableLangs().includes(stored) ? stored : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
}

export function setStoredLang(lang) {
  if (!availableLangs().includes(lang)) return;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // almacenamiento no disponible (ej. modo privado): se ignora.
  }
}

export function t(lang, key, vars = {}) {
  const dict = dictionaries[lang] || dictionaries[DEFAULT_LANG];
  let str = dict[key] ?? key;
  for (const [name, value] of Object.entries(vars)) {
    str = str.replaceAll(`{${name}}`, String(value));
  }
  return str;
}

export function availableLangs() {
  return Object.keys(dictionaries);
}
