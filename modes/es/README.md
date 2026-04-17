# career-ops — Modos en Español MX (`modes/es/`)

Esta carpeta contiene las traducciones en español mexicano de los modos principales de career-ops, para candidatos que buscan vacantes en el mercado mexicano o en empresas que operan en español.

## ¿Cuándo usar estos modos?

Usa `modes/es/` si al menos una de las siguientes condiciones es verdadera:

- Aplicas principalmente a **vacantes en español** (OCC Mundial, LinkedIn MX, CompuTrabajo, Indeed MX, Bumeran, Glassdoor MX, Gupy LATAM)
- Tu **idioma del CV** es español o alternas entre ES-MX y EN según la vacante
- Necesitas respuestas y cartas de presentación en **español profesional natural**, no traducido automáticamente
- Necesitas lidiar con **particularidades del mercado mexicano**: prestaciones de ley vs superiores a ley, aguinaldo, prima vacacional, PTU, IMSS, Infonavit, Fonacot, vales de despensa, seguro de gastos médicos mayores, nómina vs honorarios, periodo de prueba, finiquito, liquidación

Si la mayoría de tus vacantes son en inglés, quédate con los modos por defecto en `modes/`. Los modos en inglés funcionan cuando Claude detecta una vacante en español — pero no conocen las particularidades del mercado mexicano con el mismo nivel de detalle.

## ¿Cómo activarlos?

career-ops no tiene un "switch de idioma" como flag de código. En su lugar, existen dos caminos:

### Camino 1 — Por sesión, vía comando

Dile a Claude al inicio de la sesión:

> "Usa los modos en español de `modes/es/`."

o

> "Evaluación y aplicaciones en español — usa `modes/es/_shared.md` y `modes/es/oferta.md`."

Claude leerá los archivos de esta carpeta en lugar de `modes/`.

### Camino 2 — Permanente, vía perfil

Agrega en `config/profile.yml` una preferencia de idioma:

```yaml
language:
  primary: es-mx
  modes_dir: modes/es
```

Recuérdale a Claude en la primera sesión que respete ese campo ("Checa el `profile.yml`, configuré `language.modes_dir`"). A partir de ahí, Claude usará automáticamente los modos en español.

> Nota: El campo `language.modes_dir` es una convención, no un schema rígido. Si los mantenedores deciden estructurarlo distinto, el campo puede renombrarse.

## ¿Qué se tradujo?

Esta primera iteración cubre los cuatro modos de mayor impacto:

| Archivo | Traducido de | Finalidad |
|---------|--------------|-----------|
| `_shared.md` | `modes/_shared.md` (EN) | Contexto compartido, arquetipos, reglas globales, particularidades del mercado MX |
| `oferta.md` | `modes/oferta.md` (ya estaba en ES) | Evaluación completa de una vacante (Bloques A-G) |
| `postular.md` | `modes/apply.md` (EN) | Asistente en vivo para formularios de aplicación |
| `pipeline.md` | `modes/pipeline.md` (ya estaba en ES) | Inbox de URLs / Second Brain para vacantes acumuladas |

Los demás modos (`scan`, `batch`, `pdf`, `tracker`, `auto-pipeline`, `deep`, `contacto`, `ofertas`, `project`, `training`, `patterns`, `followup`, `interview-prep`) no están en esta versión a propósito. Siguen funcionando vía los originales en EN/ES, ya que su contenido es mayoritariamente tooling, paths y comandos — que deben ser independientes del idioma.

Si más candidatos del mercado mexicano adoptan estos modos, se traducirán más en PRs futuros.

## ¿Qué se queda en inglés?

Intencionalmente no traducido, porque es vocabulario estándar tech o del sistema:

- `cv.md`, `pipeline`, `tracker`, `report`, `score`, `archetype`, `proof point`
- Nombres de tools (`Playwright`, `WebSearch`, `WebFetch`, `Read`, `Write`, `Edit`, `Bash`)
- Valores de status en el tracker (`Evaluated`, `Applied`, `Interview`, `Offer`, `Rejected`, `Discarded`, `SKIP`)
- Code snippets, paths de archivo, comandos de shell

Los modos usan español mexicano profesional, como se habla en equipos reales de marketing, diseño y comunicación en CDMX, Monterrey, Guadalajara o Los Cabos: texto corrido en español, términos técnicos en inglés donde son de uso común. Nada de traducir "pipeline" a "tubería" o "cv.md" a "curriculum.md".

## Vocabulario de Referencia

Si vas a adaptar o expandir los modos, sigue este vocabulario para mantener la consistencia de tono:

| Inglés | Español MX (en esta codebase) |
|--------|--------------------------------|
| Job posting | Vacante / Oferta / Descripción del puesto |
| Application | Aplicación / Postulación |
| Cover letter | Carta de presentación |
| Resume / CV | CV / Currículum |
| Salary | Salario / Sueldo |
| Compensation | Paquete de compensación / Paquete total |
| Skills | Habilidades / Competencias |
| Interview | Entrevista |
| Hiring manager | Líder de contratación / Hiring manager |
| Recruiter | Reclutador/a |
| AI | IA (Inteligencia Artificial) |
| Requirements | Requisitos |
| Career history | Trayectoria profesional / Experiencia |
| Notice period | Aviso previo / Preaviso |
| Probation | Periodo de prueba |
| Vacation / PTO | Vacaciones / Días de descanso |
| Formal employment | Nómina / Contrato por nómina |
| Contractor / Freelance | Honorarios / Por honorarios / Freelance |
| Statutory benefits | Prestaciones de ley |
| Above-statutory benefits | Prestaciones superiores a la ley |
| Christmas bonus | Aguinaldo |
| Vacation premium | Prima vacacional |
| Profit sharing | PTU (Participación de los Trabajadores en las Utilidades) |
| Social security | IMSS |
| Housing fund | Infonavit |
| Consumer credit | Fonacot |
| Grocery vouchers | Vales de despensa |
| Health insurance (private) | Seguro de gastos médicos mayores (SGMM) |
| Savings fund | Fondo de ahorro |
| Severance | Liquidación / Finiquito (según contexto) |
| Stock options | Stock options (término usado tal cual en MX) |
| Remote | Remoto / Home office |
| Hybrid | Híbrido |
| On-site | Presencial |

## Vocabulario legal mexicano — referencia rápida

| Concepto | Definición corta |
|----------|------------------|
| **Aguinaldo** | 15 días de salario mínimo obligatorios antes del 20 de diciembre. Muchas empresas pagan 30+ días. |
| **Prima vacacional** | 25% sobre salario durante días de vacaciones (mínimo legal). |
| **PTU** | Reparto de utilidades, obligatorio desde año 2 de operación. Tope: 3 meses de salario o promedio anual de PTU recibido los últimos 3 años. |
| **IMSS** | Instituto Mexicano del Seguro Social. Cobertura pública de salud + incapacidades + jubilación. |
| **Infonavit** | Fondo de vivienda. 5% del salario aportado por el patrón, puede usarse para crédito hipotecario. |
| **Fonacot** | Crédito de consumo para trabajadores formales. |
| **Vales de despensa** | Monederos electrónicos no gravables hasta ~10-13% del salario. |
| **SGMM** | Seguro de Gastos Médicos Mayores. Cobertura privada adicional al IMSS. |
| **Fondo de ahorro** | El empleado aporta un % y la empresa iguala (hasta 13%), exento fiscalmente bajo ciertos topes. |
| **Nómina** | Contrato formal con todas las prestaciones de ley y retención de ISR por el patrón. |
| **Honorarios / Por honorarios** | Trabajo como contratista independiente. El profesional emite factura, retiene ISR/IVA, no hay prestaciones. |
| **Periodo de prueba** | Máximo 30 días (180 para puestos de dirección o técnicos especializados). |
| **Finiquito** | Pago por terminación voluntaria: vacaciones pendientes + aguinaldo proporcional + prima vacacional proporcional. |
| **Liquidación** | Pago por despido injustificado: 3 meses + 20 días por año + finiquito + prima de antigüedad. |
| **NOM-037** | Norma de teletrabajo: obliga al patrón a cubrir equipo, electricidad e internet proporcionalmente. |
| **REPSE** | Registro de Prestadoras de Servicios Especializados. La reforma de outsourcing 2021 permite outsourcing sólo para servicios especializados registrados. |

## Contribuir

Si quieres mejorar una traducción o traducir un modo adicional:

1. Abre un issue con la propuesta (según `CONTRIBUTING.md`)
2. Sigue el vocabulario de arriba para mantener el tono consistente
3. Traduce de forma natural e idiomática — nada de traducción literal palabra por palabra
4. Mantén los elementos estructurales (Bloques A-G, tablas, code blocks, instrucciones de tools) exactamente iguales
5. Prueba con una vacante real del mercado MX (ej: de OCC Mundial o LinkedIn MX) antes de abrir el PR

## Diferencia con otras variantes del español

Estos modos están optimizados para **español mexicano**. Si aplicas al mercado español peninsular, argentino, colombiano, chileno o de otros países hispanohablantes, hay diferencias importantes:

- **Vocabulario legal** varía mucho (en España: "pagas extras" en lugar de aguinaldo; "finiquito" con significado distinto)
- **Rangos salariales** distintos (España: EUR, Argentina: ARS con alta inflación)
- **Contratación** cambia (España: contrato indefinido vs temporal; Argentina: monotributo vs relación de dependencia)

Si la comunidad adopta estos modos, se pueden agregar variantes regionales (`modes/es-es/`, `modes/es-ar/`, `modes/es-co/`) en PRs futuros.
