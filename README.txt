Prueba de Evaluación SEA029_2 — aplicación web con seguimiento (Render)

Contenido
- server.js         Servidor Node (sirve la prueba y guarda las entregas).
- public/index.html La prueba (candidato) y el panel del evaluador.
- package.json      Dependencias (redis, opcional).

Variables de entorno en Render
- CLAVE_LECTURA  Clave que el evaluador escribe en su panel para ver y descargar las pruebas.
                 (se configura en Render; no se guarda en el repositorio)
- REDIS_URL      Conexión interna del Key Value de Render (prueba-sea029-kv). Si falta,
                 las entregas se guardan solo en memoria y se pierden al reiniciar.

Uso
1. Evaluador: abrir la web, entrar como Evaluador (contraseña 0112), configurar número de
   preguntas y supuestos, copiar el enlace y enviarlo al candidato.
2. Evaluador: escribir la CLAVE_LECTURA en "Seguimiento de candidatos" para ver quién está
   conectado, su avance y descargar el informe (PDF/HTML) al finalizar.
3. Candidato: abre el enlace, rellena sus datos, hace la prueba y pulsa Finalizar.
   No descarga nada; ve sus resultados y la prueba se envía al evaluador.
