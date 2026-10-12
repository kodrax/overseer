# EARS — Easy Approach to Requirements Syntax

One requirement = one sentence with exactly one `shall` (es: `deberá`). Name the system explicitly.
Avoid vague terms; put numbers in the statement or in `fit_criterion`.

| Pattern | English template | Plantilla en español |
|---|---|---|
| Ubiquitous | The <system> shall <response>. | El <sistema> deberá <respuesta>. |
| Event-driven | When <trigger>, the <system> shall <response>. | Cuando <disparador>, el <sistema> deberá <respuesta>. |
| State-driven | While <state>, the <system> shall <response>. | Mientras <estado>, el <sistema> deberá <respuesta>. |
| Unwanted behaviour | If <unwanted condition>, then the <system> shall <response>. | Si <condición no deseada>, entonces el <sistema> deberá <respuesta>. |
| Optional feature | Where <feature is included>, the <system> shall <response>. | Donde <la funcionalidad esté incluida>, el <sistema> deberá <respuesta>. |
| Complex | While <state>, when <trigger>, the <system> shall <response>. | Mientras <estado>, cuando <disparador>, el <sistema> deberá <respuesta>. |

## Examples

- Ubiquitous: "The API shall return all timestamps in ISO-8601 UTC." /
  "La API deberá devolver todas las fechas en ISO-8601 UTC."
- Event-driven: "When a user requests a password reset, the system shall email a single-use link that
  expires after 30 minutes." / "Cuando un usuario solicite restablecer la contraseña, el sistema deberá
  enviar por correo un enlace de un solo uso que caduque a los 30 minutos."
- State-driven: "While the account is locked, the system shall reject login attempts with error 423." /
  "Mientras la cuenta esté bloqueada, el sistema deberá rechazar los intentos de acceso con el error 423."
- Unwanted behaviour: "If the payment provider does not answer within 10 s, then the checkout service
  shall cancel the attempt and show a retry option." / "Si el proveedor de pagos no responde en 10 s,
  entonces el servicio de cobro deberá cancelar el intento y ofrecer reintentar."
- Optional feature: "Where two-factor authentication is enabled, the system shall require a TOTP code at
  login." / "Donde la autenticación de dos factores esté habilitada, el sistema deberá pedir un código
  TOTP al iniciar sesión."
- Complex: "While offline, when the user saves a draft, the app shall store it locally and sync it within
  60 s of reconnecting." / "Mientras esté sin conexión, cuando el usuario guarde un borrador, la app
  deberá guardarlo localmente y sincronizarlo en los 60 s siguientes a reconectar."

## Acceptance criteria (Given/When/Then)

- "Given a registered user, when they request a reset, then an email with a link arrives within 1 minute."
- "Dado un usuario registrado, cuando solicita el restablecimiento, entonces recibe un correo con el enlace en menos de 1 minuto."

<!-- managed-by: overseer-cli -->
