// Stored interface copy. The managed web assembly also adds these to i18next.
const en = {
  "Reply to your agent": "Reply to your agent",
  "Your reply": "Your reply",
  "Agent": "Agent",
  "Next available agent": "Next available agent",
  "Run this work": "Run this work",
  "Where available": "Where available",
  "On my Mac": "On my Mac",
  "In the cloud": "In the cloud",
  "In a connected chat": "In a connected chat",
  "Record a reply": "Record a reply",
  "Stop recording": "Stop recording",
  "Remove recording": "Remove recording",
  "Send reply": "Send reply",
  "Sending reply…": "Sending reply…",
  "Retry sending": "Retry sending",
  "Saved for your agent": "Saved for your agent",
  "Your reply stays saved until a capable agent picks it up.": "Your reply stays saved until a capable agent picks it up.",
  "Recording… Stop when you have finished.": "Recording… Stop when you have finished.",
  "Microphone unavailable. You can type your reply.": "Microphone unavailable. You can type your reply.",
  "Type a reply or record your voice.": "Type a reply or record your voice.",
  "Sending could not be confirmed. Retry to check the same reply.": "Sending could not be confirmed. Retry to check the same reply.",
  "Replies could not be loaded. Reopen this panel to retry.": "Replies could not be loaded. Reopen this panel to retry.",
  "Agent choices could not be loaded. Reopen this panel to retry.": "Agent choices could not be loaded. Reopen this panel to retry.",
  "Voice reply": "Voice reply",
  "Waiting for an agent": "Waiting for an agent",
  "Agent is working": "Agent is working",
  "Sent to a session": "Sent to a session",
  "Completed": "Completed",
  "Cancelled": "Cancelled",
  "Show more replies": "Show more replies",
  "Recording is too large. Record a shorter reply.": "Recording is too large. Record a shorter reply.",
  "Recording ready. You can add text before sending.": "Recording ready. You can add text before sending.",
};
type Labels = Record<keyof typeof en, string>;
const translated = (values: string[]): Labels => Object.fromEntries(Object.keys(en).map((key,i) => [key,values[i]])) as Labels;
const replyCatalogs = {
  en,
  ru: translated([
    "Ответить агенту", "Ваш ответ", "Агент", "Следующий доступный агент", "Где выполнить задачу", "Где доступно", "На моём Mac", "В облаке", "В подключённом чате", "Записать ответ", "Остановить запись", "Удалить запись", "Отправить ответ", "Отправка ответа…", "Повторить отправку", "Сохранено для вашего агента", "Ваш ответ сохранён, пока его не примет агент с нужными возможностями.", "Идёт запись… Остановите её, когда закончите.", "Микрофон недоступен. Вы можете написать ответ.", "Напишите ответ или запишите голосовое сообщение.", "Не удалось подтвердить отправку. Повторите попытку для проверки того же ответа.", "Не удалось загрузить ответы. Откройте панель снова.", "Не удалось загрузить список агентов. Откройте панель снова.", "Голосовой ответ", "Ожидает агента", "Агент работает", "Отправлено в сеанс", "Завершено", "Отменено", "Показать ещё ответы", "Запись слишком большая. Запишите более короткий ответ.", "Запись готова. Перед отправкой можно добавить текст.",
  ]),
  sv: translated([
    "Svara din agent", "Ditt svar", "Agent", "Nästa tillgängliga agent", "Kör arbetet", "Där det är tillgängligt", "På min Mac", "I molnet", "I en ansluten chatt", "Spela in ett svar", "Stoppa inspelningen", "Ta bort inspelningen", "Skicka svar", "Skickar svar…", "Försök skicka igen", "Sparat för din agent", "Ditt svar sparas tills en agent som kan utföra arbetet tar emot det.", "Spelar in… Stoppa när du är klar.", "Mikrofonen är inte tillgänglig. Du kan skriva ditt svar.", "Skriv ett svar eller spela in din röst.", "Det gick inte att bekräfta att svaret skickats. Försök igen för att kontrollera samma svar.", "Det gick inte att läsa in svaren. Öppna panelen igen.", "Det gick inte att läsa in agenterna. Öppna panelen igen.", "Röstsvar", "Väntar på en agent", "Agenten arbetar", "Skickat till en session", "Klart", "Avbrutet", "Visa fler svar", "Inspelningen är för stor. Spela in ett kortare svar.", "Inspelningen är klar. Du kan lägga till text innan du skickar.",
  ]),
  es: translated([
    "Responder a tu agente", "Tu respuesta", "Agente", "Próximo agente disponible", "Ejecutar este trabajo", "Donde esté disponible", "En mi Mac", "En la nube", "En un chat conectado", "Grabar una respuesta", "Detener grabación", "Eliminar grabación", "Enviar respuesta", "Enviando respuesta…", "Reintentar envío", "Guardado para tu agente", "Tu respuesta queda guardada hasta que la recoja un agente capaz de realizar el trabajo.", "Grabando… Detén la grabación cuando termines.", "Micrófono no disponible. Puedes escribir tu respuesta.", "Escribe una respuesta o graba tu voz.", "No se pudo confirmar el envío. Reintenta para comprobar la misma respuesta.", "No se pudieron cargar las respuestas. Vuelve a abrir el panel.", "No se pudieron cargar los agentes. Vuelve a abrir el panel.", "Respuesta de voz", "Esperando a un agente", "El agente está trabajando", "Enviado a una sesión", "Completado", "Cancelado", "Mostrar más respuestas", "La grabación es demasiado grande. Graba una respuesta más corta.", "Grabación lista. Puedes añadir texto antes de enviarla.",
  ]),
};

const connectionLabels = {
  en: {
    "Project connection":"Project connection", "Choose a project connection":"Choose a project connection", "Connect a project":"Connect a project", "Connection name":"Connection name", "Cloud environment ID":"Cloud environment ID", "Local project folder":"Local project folder", "Project context":"Project context", "Save connection":"Save connection", "Connection saved":"Connection saved", "Open Codex":"Open Codex",
    "This connection belongs to your account. Select the environment or folder that has the right project context.":"This connection belongs to your account. Select the environment or folder that has the right project context.",
    "The environment supplies the repository. Your reply includes the overview transcript and playback position.":"The environment supplies the repository. Your reply includes the overview transcript and playback position.",
    "Connections could not be loaded. Reopen this panel to retry.":"Connections could not be loaded. Reopen this panel to retry.",
    "Connection could not be saved. Check the fields and try again.":"Connection could not be saved. Check the fields and try again.",
    "Reply was not accepted. Check your reply and connection, then try again.":"Reply was not accepted. Check your reply and connection, then try again.",
    "A connected runner must be available to submit work. Otherwise your reply stays saved.":"A connected runner must be available to submit work. Otherwise your reply stays saved.",
  },
  ru: {
    "Project connection":"Подключение проекта", "Choose a project connection":"Выберите подключение проекта", "Connect a project":"Подключить проект", "Connection name":"Название подключения", "Cloud environment ID":"Идентификатор облачной среды", "Local project folder":"Локальная папка проекта", "Project context":"Контекст проекта", "Save connection":"Сохранить подключение", "Connection saved":"Подключение сохранено", "Open Codex":"Открыть Codex",
    "This connection belongs to your account. Select the environment or folder that has the right project context.":"Это подключение относится к вашей учётной записи. Выберите среду или папку с нужным контекстом проекта.",
    "The environment supplies the repository. Your reply includes the overview transcript and playback position.":"Среда предоставляет репозиторий. В ответ включаются текст обзора и позиция воспроизведения.",
    "Connections could not be loaded. Reopen this panel to retry.":"Не удалось загрузить подключения. Откройте панель снова.",
    "Connection could not be saved. Check the fields and try again.":"Не удалось сохранить подключение. Проверьте поля и повторите попытку.",
    "Reply was not accepted. Check your reply and connection, then try again.":"Ответ не принят. Проверьте ответ и подключение, затем повторите попытку.",
    "A connected runner must be available to submit work. Otherwise your reply stays saved.":"Для отправки задачи нужна доступная подключённая программа запуска. Иначе ответ останется сохранённым.",
  },
  sv: {
    "Project connection":"Projektanslutning", "Choose a project connection":"Välj en projektanslutning", "Connect a project":"Anslut ett projekt", "Connection name":"Anslutningens namn", "Cloud environment ID":"Molnmiljöns ID", "Local project folder":"Lokal projektmapp", "Project context":"Projektets sammanhang", "Save connection":"Spara anslutning", "Connection saved":"Anslutningen har sparats", "Open Codex":"Öppna Codex",
    "This connection belongs to your account. Select the environment or folder that has the right project context.":"Anslutningen tillhör ditt konto. Välj miljön eller mappen med rätt projektkontext.",
    "The environment supplies the repository. Your reply includes the overview transcript and playback position.":"Miljön tillhandahåller kodarkivet. Ditt svar innehåller översiktens text och uppspelningsposition.",
    "Connections could not be loaded. Reopen this panel to retry.":"Det gick inte att läsa in anslutningarna. Öppna panelen igen.",
    "Connection could not be saved. Check the fields and try again.":"Det gick inte att spara anslutningen. Kontrollera fälten och försök igen.",
    "Reply was not accepted. Check your reply and connection, then try again.":"Svaret togs inte emot. Kontrollera ditt svar och anslutningen och försök igen.",
    "A connected runner must be available to submit work. Otherwise your reply stays saved.":"En ansluten körprocess måste vara tillgänglig för att skicka arbetet. Annars ligger ditt svar kvar.",
  },
  es: {
    "Project connection":"Conexión del proyecto", "Choose a project connection":"Elige una conexión de proyecto", "Connect a project":"Conectar un proyecto", "Connection name":"Nombre de la conexión", "Cloud environment ID":"ID del entorno en la nube", "Local project folder":"Carpeta local del proyecto", "Project context":"Contexto del proyecto", "Save connection":"Guardar conexión", "Connection saved":"Conexión guardada", "Open Codex":"Abrir Codex",
    "This connection belongs to your account. Select the environment or folder that has the right project context.":"Esta conexión pertenece a tu cuenta. Selecciona el entorno o la carpeta con el contexto adecuado del proyecto.",
    "The environment supplies the repository. Your reply includes the overview transcript and playback position.":"El entorno proporciona el repositorio. Tu respuesta incluye la transcripción del resumen y la posición de reproducción.",
    "Connections could not be loaded. Reopen this panel to retry.":"No se pudieron cargar las conexiones. Vuelve a abrir el panel.",
    "Connection could not be saved. Check the fields and try again.":"No se pudo guardar la conexión. Revisa los campos e inténtalo de nuevo.",
    "Reply was not accepted. Check your reply and connection, then try again.":"La respuesta no se aceptó. Revisa tu respuesta y la conexión e inténtalo de nuevo.",
    "A connected runner must be available to submit work. Otherwise your reply stays saved.":"Debe haber un ejecutor conectado disponible para enviar el trabajo. De lo contrario, tu respuesta queda guardada.",
  },
};
const pageLabels = {
  en: {"Audio":"Audio","Inbox":"Inbox","Show more":"Show more","Transcript":"Transcript","Audio could not be loaded.":"Audio could not be loaded.","Waiting for an agent that can use audio":"Waiting for an agent that can use audio"},
  ru: {"Audio":"Аудио","Inbox":"Входящие","Show more":"Показать ещё","Transcript":"Текст записи","Audio could not be loaded.":"Не удалось загрузить аудио.","Waiting for an agent that can use audio":"Ожидает агента, который может обработать аудио"},
  sv: {"Audio":"Ljud","Inbox":"Inkorg","Show more":"Visa fler","Transcript":"Transkription","Audio could not be loaded.":"Det gick inte att läsa in ljudet.","Waiting for an agent that can use audio":"Väntar på en agent som kan hantera ljud"},
  es: {"Audio":"Audio","Inbox":"Bandeja de entrada","Show more":"Mostrar más","Transcript":"Transcripción","Audio could not be loaded.":"No se pudo cargar el audio.","Waiting for an agent that can use audio":"Esperando a un agente que pueda procesar audio"},
};
export const assignmentCatalogs: Record<keyof typeof replyCatalogs,Record<string,string>> = {
  en:{...replyCatalogs.en,...connectionLabels.en,...pageLabels.en},
  ru:{...replyCatalogs.ru,...connectionLabels.ru,...pageLabels.ru},
  sv:{...replyCatalogs.sv,...connectionLabels.sv,...pageLabels.sv},
  es:{...replyCatalogs.es,...connectionLabels.es,...pageLabels.es},
};
