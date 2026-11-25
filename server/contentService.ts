import { GoogleGenAI, Type } from '@google/genai';
import type { AiTestResult, MessageFormat } from '../shared/types';
import { DEFAULT_AI_MODEL } from '../shared/types';

export interface GeneratedEmailContent {
  subject: string;
  text: string;
  html?: string;
  usedFallback: boolean;
  fallbackReason?: string;
}

export interface GeneratedReplyContent {
  text: string;
  html?: string;
  usedFallback: boolean;
  fallbackReason?: string;
}

interface InitialTemplate {
  subject: string;
  body: string;
}

const FALLBACK_INITIAL_TEMPLATES: InitialTemplate[] = [
  {
    subject: 'Krótkie pytanie o harmonogram spotkania w przyszłym tygodniu',
    body: 'Cześć,\n\nchciałem tylko dopytać, czy wtorek albo środa przed południem będą dla Ciebie wygodne na krótką rozmowę organizacyjną.\n\nDaj znać, która godzina bardziej pasuje.\n\nPozdrawiam,\nZespół operacyjny',
  },
  {
    subject: 'Podsumowanie ustaleń po wczorajszym callu',
    body: 'Dzień dobry,\n\ndziękuję za wczorajszą rozmowę. Zebrałem główne punkty w notatkach i do końca tygodnia podeślę zaktualizowaną wersję planu.\n\nGdyby pojawiły się dodatkowe uwagi, śmiało napisz.\n\nPozdrawiam serdecznie',
  },
  {
    subject: 'Prośba o potwierdzenie terminu przeglądu dokumentacji',
    body: 'Cześć,\n\nczy uda nam się w czwartek przejrzeć wspólnie zaktualizowany opis procesu wdrożeniowego? Wystarczy nam około 20 minut.\n\nBędę wdzięczny za krótkie potwierdzenie.\n\nPozdrawiam',
  },
  {
    subject: 'Aktualizacja statusu prac kwartalnych',
    body: 'Dzień dobry,\n\nkrótka informacja z naszej strony — pierwsza część prac została zamknięta zgodnie z planem, a na kolejny etap przechodzimy od poniedziałku.\n\nDaj znać, jeśli potrzebujesz dodatkowych szczegółów przed spotkaniem.\n\nMiłego dnia',
  },
  {
    subject: 'Pytanie o dostępność w drugiej połowie tygodnia',
    body: 'Cześć,\n\nplanujemy krótką synchronizację przed zamknięciem miesiąca. Czy czwartek po 13:00 albo piątek rano wchodzą w grę?\n\nDziękuję z góry za odpowiedź.\n\nPozdrawiam',
  },
  {
    subject: 'Notatki z przeglądu priorytetów na kolejny sprint',
    body: 'Dzień dobry,\n\nprzejrzałem listę tematów na najbliższe dwa tygodnie i wygląda to bardzo spójnie. Zostawiłem dwie drobne uwagi do kolejności zadań.\n\nPorozmawiamy o tym krótko przy najbliższej okazji.\n\nPozdrawiam',
  },
  {
    subject: 'Quick check-in regarding next week schedule',
    body: 'Hi,\n\nJust checking in to see whether Tuesday morning still works for our brief planning sync. Happy to adjust the time if needed.\n\nBest regards',
  },
  {
    subject: 'Follow-up on internal workflow notes',
    body: 'Hello,\n\nThanks for sharing the updated workflow outline earlier. Everything looks clear from our side, and we can finalize the remaining steps later this week.\n\nBest',
  },
  {
    subject: 'Drobna korekta w agendzie spotkania',
    body: 'Cześć,\n\ndodałem jeszcze jeden punkt do naszej agendy dotyczący podziału zadań na przyszły miesiąc. Całość powinna zamknąć się w pół godziny.\n\nDo usłyszenia wkrótce.\n\nPozdrawiam',
  },
  {
    subject: 'Potwierdzenie materiałów na spotkanie zespołu',
    body: 'Dzień dobry,\n\nwszystkie prezentacje na jutrzejsze spotkanie są już skompletowane i sprawdzone. Jeśli chcesz coś jeszcze dopisać, daj proszę znać do rana.\n\nPozdrawiam serdecznie',
  },
];

const FALLBACK_REPLY_TEMPLATES: string[] = [
  'Cześć,\n\ndzięki za wiadomość! Termin wygląda dobrze z mojej strony, dopisałem już spotkanie do kalendarza.\n\nDo usłyszenia,\nPozdrawiam',
  'Dzień dobry,\n\npotwierdzam odbiór i dzięki za szybką aktualizację. Wszystko jest jasne, wrócę z ewentualnymi uwagami jutro rano.\n\nPozdrawiam',
  'Cześć,\n\nsuper, dzięki za informację. Czwartek przed południem będzie dla mnie najlepszy — prześlij proszę zaproszenie jak znajdziesz chwilę.\n\nMiłego dnia!',
  'Dziękuję za podsumowanie. Przejrzałem wszystkie punkty i z mojej strony nie ma żadnych zastrzeżeń, możemy działać zgodnie z planem.\n\nPozdrawiam serdecznie',
  'Hi,\n\nThanks for the note! That schedule works well on my end. Let us touch base as planned.\n\nBest regards',
  'Cześć,\n\nwszystko się zgadza, dzięki za koordynację. W razie czego jestem dostępny w drugiej połowie dnia.\n\nPozdrawiam',
  'Dzień dobry,\n\nświetnie, że udało się to szybko spiąć. Do zobaczenia na spotkaniu!\n\nPozdrawiam',
];

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Converts plain text into clean, lightweight HTML (no remote images, no trackers, no scripts).
 */
export function buildLightHtml(plainText: string): string {
  const paragraphs = plainText
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1e293b;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<!doctype html><html><body style="margin:0;padding:8px 0;">${paragraphs}</body></html>`;
}

export interface GenAiCaller {
  generateJson: (model: string, systemInstruction: string, prompt: string, schema: Record<string, unknown>) => Promise<string | undefined>;
}

export function createDefaultGenAiCaller(apiKey?: string): GenAiCaller | null {
  const key = (apiKey ?? process.env.GEMINI_API_KEY ?? '').trim();
  if (!key || key === 'MY_GEMINI_API_KEY') return null;

  const ai = new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  return {
    async generateJson(model, systemInstruction, prompt, schema) {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      });
      return response.text;
    },
  };
}

function classifyError(err: unknown): { code: AiTestResult['status']; reason: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const statusNum = (err as { status?: number; code?: number })?.status ?? (err as { code?: number })?.code;

  if (statusNum === 429 || /\b429\b|RESOURCE_EXHAUSTED|quota|rate limit/i.test(raw)) {
    return { code: 'fallback_rate_limit', reason: 'Limit zapytań Gemini API (HTTP 429) — użyto szablonu fallback.' };
  }
  if (statusNum === 404 || /\b404\b|NOT_FOUND|not found/i.test(raw)) {
    return { code: 'fallback_model_error', reason: 'Wybrany model Gemini jest niedostępny (HTTP 404) — użyto szablonu fallback.' };
  }
  if (statusNum === 401 || statusNum === 403 || /API_KEY_INVALID|PERMISSION_DENIED/i.test(raw)) {
    return { code: 'fallback_missing_key', reason: 'Błędny lub nieaktywny GEMINI_API_KEY — użyto szablonu fallback.' };
  }
  return { code: 'fallback_network', reason: `Błąd połączenia z Gemini API (${raw.slice(0, 100)}) — użyto szablonu fallback.` };
}

export async function generateInitialWarmupEmail(options: {
  model?: string;
  format: MessageFormat;
  caller?: GenAiCaller | null;
  rng?: () => number;
}): Promise<GeneratedEmailContent> {
  const model = (options.model || DEFAULT_AI_MODEL).trim();
  const rng = options.rng ?? Math.random;
  const caller = options.caller !== undefined ? options.caller : createDefaultGenAiCaller();

  if (caller) {
    try {
      const systemInstruction =
        'Piszesz krótkie, naturalne, neutralne wiadomości e-mail B2B/biurowe po polsku (czasem po angielsku). ' +
        'ZASADY: 1) Żadnych prawdziwych nazw firm ani danych klientów. 2) Żadnych sztucznych tagów ani identyfikatorów typu [WARMUP]. ' +
        '3) Żadnych linków, ofert sprzedażowych, słów spamowych ani załączników. 4) Temat 4-9 słów, treść 2-4 krótkie zdania.';
      const prompt = 'Wygeneruj jedną naturalną, uprzejmą wiadomość biurową (np. ustalenie terminu krótkiej rozmowy, podsumowanie notatek, status zadania).';
      const schema = {
        type: Type.OBJECT,
        properties: {
          subject: { type: Type.STRING, description: 'Natural email subject without tags.' },
          body: { type: Type.STRING, description: 'Short plain-text body (2-4 sentences).' },
        },
        required: ['subject', 'body'],
      };

      const raw = await caller.generateJson(model, systemInstruction, prompt, schema);
      if (raw) {
        const parsed = JSON.parse(raw.trim()) as { subject?: string; body?: string };
        const subject = (parsed.subject ?? '').replace(/\[WARMUP[^\]]*\]/gi, '').trim();
        const text = (parsed.body ?? '').replace(/\[WARMUP[^\]]*\]/gi, '').trim();
        if (subject.length >= 3 && text.length >= 15) {
          return {
            subject: subject.slice(0, 160),
            text,
            html: options.format === 'light_html' ? buildLightHtml(text) : undefined,
            usedFallback: false,
          };
        }
      }
      throw new Error('Pusta odpowiedź z modelu Gemini.');
    } catch (err) {
      const { reason } = classifyError(err);
      const tpl = FALLBACK_INITIAL_TEMPLATES[Math.floor(rng() * FALLBACK_INITIAL_TEMPLATES.length) % FALLBACK_INITIAL_TEMPLATES.length];
      return {
        subject: tpl.subject,
        text: tpl.body,
        html: options.format === 'light_html' ? buildLightHtml(tpl.body) : undefined,
        usedFallback: true,
        fallbackReason: reason,
      };
    }
  }

  const tpl = FALLBACK_INITIAL_TEMPLATES[Math.floor(rng() * FALLBACK_INITIAL_TEMPLATES.length) % FALLBACK_INITIAL_TEMPLATES.length];
  return {
    subject: tpl.subject,
    text: tpl.body,
    html: options.format === 'light_html' ? buildLightHtml(tpl.body) : undefined,
    usedFallback: true,
    fallbackReason: 'Brak skonfigurowanego GEMINI_API_KEY — użyto wbudowanego szablonu konwersacyjnego.',
  };
}

export async function generateContextualReply(options: {
  model?: string;
  format: MessageFormat;
  originalSubject: string;
  originalSnippet: string;
  caller?: GenAiCaller | null;
  rng?: () => number;
}): Promise<GeneratedReplyContent> {
  const model = (options.model || DEFAULT_AI_MODEL).trim();
  const rng = options.rng ?? Math.random;
  const caller = options.caller !== undefined ? options.caller : createDefaultGenAiCaller();

  if (caller) {
    try {
      const systemInstruction =
        'Piszesz bardzo krótką (2-3 zdania), naturalną odpowiedź na wiadomość służbową w tym samym języku co oryginał. ' +
        'Bez linków, bez sztucznych znaczników, bez danych osobowych.';
      const prompt = `Temat wiadomości: ${options.originalSubject.slice(0, 140)}\nFragment treści: ${options.originalSnippet.slice(0, 400)}\nNapisz uprzejmą, naturalną odpowiedź.`;
      const schema = {
        type: Type.OBJECT,
        properties: {
          body: { type: Type.STRING, description: 'Short contextual reply in plain text.' },
        },
        required: ['body'],
      };

      const raw = await caller.generateJson(model, systemInstruction, prompt, schema);
      if (raw) {
        const parsed = JSON.parse(raw.trim()) as { body?: string };
        const text = (parsed.body ?? '').replace(/\[WARMUP[^\]]*\]/gi, '').trim();
        if (text.length >= 10) {
          return {
            text,
            html: options.format === 'light_html' ? buildLightHtml(text) : undefined,
            usedFallback: false,
          };
        }
      }
      throw new Error('Pusta odpowiedź z modelu Gemini.');
    } catch (err) {
      const { reason } = classifyError(err);
      const text = FALLBACK_REPLY_TEMPLATES[Math.floor(rng() * FALLBACK_REPLY_TEMPLATES.length) % FALLBACK_REPLY_TEMPLATES.length];
      return {
        text,
        html: options.format === 'light_html' ? buildLightHtml(text) : undefined,
        usedFallback: true,
        fallbackReason: reason,
      };
    }
  }

  const text = FALLBACK_REPLY_TEMPLATES[Math.floor(rng() * FALLBACK_REPLY_TEMPLATES.length) % FALLBACK_REPLY_TEMPLATES.length];
  return {
    text,
    html: options.format === 'light_html' ? buildLightHtml(text) : undefined,
    usedFallback: true,
    fallbackReason: 'Brak skonfigurowanego GEMINI_API_KEY — użyto szablonu odpowiedzi.',
  };
}

export async function testGeminiConnection(options: {
  model?: string;
  caller?: GenAiCaller | null;
}): Promise<AiTestResult> {
  const model = (options.model || DEFAULT_AI_MODEL).trim();
  const started = Date.now();
  const caller = options.caller !== undefined ? options.caller : createDefaultGenAiCaller();

  if (!caller) {
    return {
      ok: false,
      model,
      latencyMs: Date.now() - started,
      fallbackReady: true,
      status: 'fallback_missing_key',
      message:
        'Brak GEMINI_API_KEY w zmiennych środowiskowych serwera (.env) — silnik będzie korzystał z wbudowanej puli szablonów (fallback).',
    };
  }

  try {
    const res = await generateInitialWarmupEmail({ model, format: 'plain', caller });
    const latencyMs = Date.now() - started;
    if (!res.usedFallback) {
      return {
        ok: true,
        model,
        latencyMs,
        fallbackReady: true,
        status: 'connected',
        message: `Połączono z modelem ${model} (${latencyMs} ms). Tryb fallback gotowy w razie limitu 429.`,
        sampleSubject: res.subject,
      };
    }

    const is429 = res.fallbackReason?.includes('429');
    const is404 = res.fallbackReason?.includes('404');
    return {
      ok: false,
      model,
      latencyMs,
      fallbackReady: true,
      status: is429 ? 'fallback_rate_limit' : is404 ? 'fallback_model_error' : 'fallback_network',
      message: res.fallbackReason ?? 'Błąd wywołania Gemini API — aktywny tryb fallback.',
    };
  } catch (err) {
    const classified = classifyError(err);
    return {
      ok: false,
      model,
      latencyMs: Date.now() - started,
      fallbackReady: true,
      status: classified.code,
      message: classified.reason,
    };
  }
}
