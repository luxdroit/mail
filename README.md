# MailPulse Warm-up Console — Samodzielne wdrożenie

Aplikacja działa jako w pełni samodzielna strona internetowa (Node.js + Express + React) na dowolnym hostingu obsługującym Node.js lub Docker (VPS, Railway, Render, Fly.io, Google Cloud Run).

## 1. Własny projekt Firebase (Firestore + Google Sign-In)
1. Utwórz projekt w [Firebase Console](https://console.firebase.google.com/).
2. Włącz **Authentication → Sign-in method → Google** i dodaj swoją domenę w **Authentication → Settings → Authorized domains**.
3. Utwórz bazę **Cloud Firestore** i wdróż reguły z pliku `firestore.rules` (`firebase deploy --only firestore:rules`).
4. Skopiuj publiczną konfigurację aplikacji webowej do zmiennych `VITE_FIREBASE_*` w `.env`.
5. (Dla automatycznego crona `POST /api/cron/tick` poza Cloud Run) Wygeneruj klucz konta serwisowego (**Project Settings → Service accounts → Generate new private key**) z rolą **Cloud Datastore User** (`roles/datastore.user`) i zapisz jego treść w `FIREBASE_SERVICE_ACCOUNT_JSON` (surowy JSON lub base64) albo wskaż ścieżkę pliku przez `GOOGLE_APPLICATION_CREDENTIALS`.

## 2. Konfiguracja `.env` (własny `GEMINI_API_KEY` i sekrety)
Skopiuj `.env.example` do `.env` i uzupełnij własne wartości:

- `GEMINI_API_KEY` — Twój własny klucz Gemini API (używany wyłącznie po stronie serwera; jeśli pusty, aplikacja działa w trybie wbudowanych szablonów fallback).
- `ENCRYPTION_KEY` — 64 znaki hex (32 bajty) do szyfrowania haseł skrzynek AES-256-GCM (`openssl rand -hex 32`).
- `CRON_SECRET` — losowy token autoryzacji `cron-job.org` (`openssl rand -hex 24`).
- `APP_URL` — docelowy adres Twojej strony (np. `https://warmup.twojadomena.pl`).
- `FIREBASE_PROJECT_ID`, `FIREBASE_DATABASE_ID` oraz `VITE_FIREBASE_*` — dane Twojego projektu Firebase.

## 3. Uruchomienie produkcyjne

### Node.js (VPS / Railway / Render)
```bash
npm ci
npm run build
npm run start:standalone
```

### Docker
```bash
docker build \
  --build-arg VITE_FIREBASE_API_KEY="..." \
  --build-arg VITE_FIREBASE_AUTH_DOMAIN="..." \
  --build-arg VITE_FIREBASE_PROJECT_ID="..." \
  --build-arg VITE_FIREBASE_APP_ID="..." \
  -t mailpulse-warmup .

docker run -d --name mailpulse -p 3000:3000 --env-file .env mailpulse-warmup
```

## 4. Dostęp dla innych osób i Cron
- Pierwsze konto Google zalogowane na nowej instancji zostaje jej właścicielem.
- Dodatkowe osoby z zespołu możesz dodać w zakładce **AI i dostęp → Właściciel i współwłaściciele**.
- W zakładce **Konfiguracja Cron** znajdziesz gotowy adres `POST <Twój_URL>/api/cron/tick` oraz nagłówek `Authorization: Bearer <CRON_SECRET>` do wklejenia w `cron-job.org` (co 10–15 min).
