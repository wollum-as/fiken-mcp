# Fiken MCP

Hostet MCP-server for Fiken. Koble Claude eller ChatGPT til regnskapet ditt med Fiken-innlogging. Ingen API-nøkler.

Laget og vedlikeholdt av Wollum AS. Prosjektet er ikke tilknyttet Fiken AS, og Fiken AS har ikke godkjent eller kontrollert det.

## Kom i gang

1. Legg til en egen connector i Claude (Innstillinger → Connectors → «Add custom connector») eller i ChatGPT, med adressen:

   ```
   https://fiken.mcp.wollums.no/mcp
   ```

2. Velg tilgang på siden som åpnes:
   - **Kun lesing:** assistenten kan se, men ikke endre noe.
   - **Lesing og skriving:** assistenten kan også lage utkast, bokføre, registrere betalinger og sende fakturaer.
3. Logg inn med Fiken og gi tilgang til foretakene du vil bruke.

Hvert foretak må ha Fikens API-tillegg. Du kan trekke tilbake tilgangen når som helst i Fiken under Rediger konto → Sikkerhet → Apper du har gitt tilgang til.

## Hva assistenten kan gjøre

**Lese**
- Foretak, kunder og leverandører, produkter
- Fakturaer, kreditnotaer, salg og kjøp, også utkast. Finne kjøp som mangler kvittering, for eksempel kortkjøp fra superføring
- Kontoplan, saldo, bankkontoer, bilag og innboks
- Rapporter: resultat, balanse, kundefordringer, leverandørgjeld, salg per produkt
- Hjelp til å forstå tall: MVA per termin, lønn og trekk per måned, og kontroll av bankkonto
- Andre data i Fiken, som tilbud, ordrebekreftelser, prosjekter og timer

**Skrive** (bare med «Lesing og skriving»)
- Opprette og endre kunder og leverandører. Navn og adresse hentes fra Enhetsregisteret, og den stopper hvis kontakten allerede finnes.
- Opprette og endre produkter
- Lage utkast til kjøp, salg, faktura, kreditnota og tilbud
- Gi deg en lenke der du laster opp kvittering eller bilag, eller legge et dokument fra innboksen på et kjøp eller salg

**Bokføre og sende** (assistenten skal alltid be deg bekrefte først)
- Gjøre et utkast endelig, slik at det bokføres
- Registrere en betaling som allerede har skjedd
- Føre manuelt bilag
- Kreditere en faktura
- Sende faktura, kreditnota eller tilbud
- Slette utkast

## Det assistenten ikke gjør

- Leverer ikke MVA-melding eller A-melding.
- Avstemmer ikke bank, men viser hva som ser feil ut.
- Flytter ikke penger. «Registrer betaling» fører bare en betaling som har skjedd.
- Er ikke regnskapsfører. Ved tvil om regnskapsmessig behandling bør du spørre en regnskapsfører.

For spørsmål om Fiken peker assistenten til [Fikens hjelpesider](https://hjelp.fiken.no) og [kontohjelpen](https://kontohjelp.fiken.no). For MVA-melding og A-melding peker den til [Skatteetaten](https://www.skatteetaten.no).

## Sikkerhet og personvern

- Du logger inn hos Fiken, ikke hos oss. Vi ser aldri passordet ditt.
- Assistenten får bare tilgang til sine egne nøkler hos oss, aldri til Fiken-nøklene dine. Fiken-nøklene lagres kryptert, og kan bare låses opp med assistentens nøkkel.
- Regnskapsdata lagres ikke hos oss. Hvert spørsmål hentes direkte fra Fiken.
- Logger inneholder bare hvilket verktøy som ble brukt, foretak, status og tid. Aldri beløp, navn eller nøkler.
- Bare Claude og ChatGPT kan koble til.
- Opplastingslenker virker én gang i 15 minutter.

Har du funnet et sikkerhetshull? Send e-post til kontakt@wollums.no, og se [SECURITY.md](SECURITY.md).

Vilkår, personvernerklæring og veiledning ligger på [wollums.no](https://wollums.no).

## For utviklere

Kildekoden er åpen under Apache-2.0. Se [LICENSE](LICENSE) og [NOTICE](NOTICE).

- `packages/core`: verktøyene, Fiken-klienten og MCP-serveren. Plattformuavhengig, slik at den kan brukes i andre miljøer, for eksempel av Fiken selv. Se [packages/core/README.md](packages/core/README.md) for hvordan den bygges inn.
- `apps/cloudflare`: Cloudflare Worker med OAuth, samtykkeside, opplastingsside og køen som holder seg innenfor Fikens grenser (ett kall om gangen, maks fire i sekundet). Se [apps/cloudflare/README.md](apps/cloudflare/README.md) for oppsett, deploy og drift.
- `spec/fiken-openapi.yaml`: Fikens OpenAPI-spesifikasjon. Typer og tillatte leseoperasjoner genereres fra den.
- `docs/HANDOFF.md`: spesifikasjon, beslutninger og målinger mot Fiken-APIet.

```bash
pnpm install
```

```bash
pnpm check
```

`pnpm check` bygger, kjører lint og tester. `pnpm test:integration` kjører mot et testforetak i Fiken og krever `FIKEN_TEST_TOKEN` i `.dev.vars`. Med `FIKEN_DESTRUCTIVE_TESTS=1` bokfører testene også i testforetaket og annullerer etterpå.
