// Hand-authored synthetic Scout-shaped corpus for offline retrieval experiments.
// No live posts or people are represented. Gold below is independent of mission
// literals and matcher output; it is a fixture annotation, not a model verdict.
import { digest } from '../../business/source-ingestion.mjs';

export const syntheticCorpusKind = 'SYNTHETIC_AUTHORED_TEST_CORPUS';

const records = [
  {
    message_id: '5001', author_ref: 'synthetic-ru-01', date: '2026-09-01T09:00:00.000Z',
    text: 'Я веду студию ремонта одежды. Клиенты спрашивают про товары для ухода за тканью, а я пока предлагаю только услуги. Хочу понять, как добавить такие товары без обязательной закупки большой партии и сколько это потребует времени.',
    reply_to: null, unsupported: false,
  },
  {
    message_id: '5002', author_ref: 'synthetic-peer-01', date: '2026-09-01T09:08:00.000Z',
    text: 'Для начала можно сравнить поставщиков, которые отправляют заказ напрямую покупателю; условия комиссии надо проверять отдельно.',
    reply_to: '5001', unsupported: false,
  },
  {
    message_id: '5003', author_ref: 'synthetic-ru-02', date: '2026-09-01T10:00:00.000Z',
    text: 'У меня запись заполнена на недели вперёд, но не могу брать больше клиентов: работаю одна и дополнительных часов нет. Ищу способ обслуживать спрос без увеличения часов приёма.',
    reply_to: null, unsupported: false,
  },
  {
    message_id: '5004', author_ref: 'synthetic-ua-01', date: '2026-09-01T11:00:00.000Z',
    text: 'Клієнти моєї майстерні запитують про товари для догляду за виробами. Не хочу вступати в MLM і не погоджуюся на обов’язковий стартовий пакет. Шукаю варіант співпраці без закупівлі партії та з доставкою клієнту.',
    reply_to: null, unsupported: false,
  },
  {
    message_id: '5005', author_ref: 'synthetic-ua-02', date: '2026-09-01T12:00:00.000Z',
    text: 'Порівнюю моделі монетизації рекомендацій для своєї студії: фіксована оплата за підбір чи партнерська комісія з продажу. Який обсяг роботи й умови зазвичай треба врахувати?',
    reply_to: null, unsupported: false,
  },
  {
    message_id: '5006', author_ref: 'synthetic-ru-03', date: '2026-09-01T13:00:00.000Z',
    text: 'Ищу поставщика наборов для творчества с доставкой поштучно. Нет места для хранения, поэтому не хочу держать остатки или делать минимальный оптовый заказ. Нужно понять, какие варианты вообще доступны для моих учеников.',
    reply_to: null, unsupported: false,
  },
  {
    message_id: '5007', author_ref: 'synthetic-seller-01', date: '2026-09-01T14:00:00.000Z',
    text: 'В отзыве клиента было: «Клиенты спрашивают про товары, где их заказать?» Я продавец и ищу новых партнёров для своей витрины.',
    reply_to: null, unsupported: false,
  },
  {
    message_id: '5008', author_ref: 'synthetic-ru-04', date: '2026-09-01T15:00:00.000Z',
    text: 'Коллега написала: «Ищу поставщика с доставкой поштучно, без склада». Пересылаю её вопрос для обсуждения; это не мой запрос и я ничего не подбираю.',
    reply_to: null, unsupported: false,
  },
  {
    message_id: '5009', author_ref: 'synthetic-ru-05', date: '2026-09-01T16:00:00.000Z',
    text: 'Я фотограф, у меня около четырёхсот постоянных клиентов и активная группа. Подписчики часто спрашивают, чем я пользуюсь на съёмках.',
    reply_to: null, unsupported: false,
  },
  {
    message_id: '5010', author_ref: 'synthetic-ru-01', date: '2026-09-02T08:00:00.000Z',
    text: 'По другой теме: я передумала добавлять товары к услугам. Пока оставляю только ремонт и не рассматриваю поставщиков или партнёрские модели.',
    reply_to: null, unsupported: false,
  },
  {
    message_id: '5011', author_ref: 'synthetic-ua-03', date: '2026-09-02T08:30:00.000Z',
    text: null, reply_to: null, unsupported: true,
  },
  {
    message_id: '5012', author_ref: 'synthetic-ua-04', date: '2026-09-02T08:35:00.000Z',
    text: 'Так, мені теж було б цікаво, але контекст попереднього повідомлення не видно.',
    reply_to: '5011', unsupported: false,
  },
  {
    message_id: '5013', author_ref: 'synthetic-ru-06', date: '2026-09-02T09:00:00.000Z',
    text: 'Да, мне тоже нужен такой поставщик. Подробности исходного вопроса не сохранились.',
    reply_to: '5999', unsupported: false,
  },
  {
    message_id: '5014', author_ref: 'synthetic-ru-02', date: '2026-09-02T09:30:00.000Z',
    text: 'На этой неделе у меня выходной в четверг, хочу съездить за город и почитать книгу.',
    reply_to: null, unsupported: false,
  },
  {
    message_id: '5015', author_ref: 'synthetic-ru-02', date: '2026-09-02T09:35:00.000Z',
    text: 'У меня запись заполнена на недели вперёд, но не могу брать больше клиентов: работаю одна и дополнительных часов нет. Ищу способ обслуживать спрос без увеличения часов приёма.',
    reply_to: null, unsupported: false,
  },
  {
    message_id: '5016', author_ref: 'synthetic-ru-08', date: '2026-09-02T10:00:00.000Z',
    text: 'Запись заполнена. Как поднять чек, не работая дольше?',
    reply_to: null, unsupported: false,
  },
  {
    message_id: '5017', author_ref: 'synthetic-peer-02', date: '2026-09-02T10:30:00.000Z',
    text: 'Дякую всім за поради щодо розкладу. Гарного дня!',
    reply_to: null, unsupported: false,
  },
  {
    message_id: '5018', author_ref: 'synthetic-ua-06', date: '2026-09-02T11:00:00.000Z',
    text: 'Покупці в моїй майстерні питають, де замовити матеріали для ремонту. Хочу додати товари до послуг, але не хочу вкладати гроші в товарний запас. Шукаю модель співпраці з відправкою безпосередньо клієнту.',
    reply_to: null, unsupported: false,
  },
  {
    message_id: '5019', author_ref: 'synthetic-ru-07', date: '2026-09-02T12:00:00.000Z',
    text: 'Сравниваю способы заработка на подборе книг для учеников: разовая оплата против процента с продаж. Хочу понять, как это оформить и сколько времени занимает сопровождение.',
    reply_to: null, unsupported: false,
  },
  {
    message_id: '5020', author_ref: 'synthetic-seller-02', date: '2026-09-02T13:00:00.000Z',
    text: 'Я представляю каталог товаров. Пишите мне, чтобы вступить в нашу команду и продавать по партнёрской программе.',
    reply_to: null, unsupported: false,
  },
  {
    message_id: '5021', author_ref: 'synthetic-ua-07', date: '2026-09-02T14:00:00.000Z',
    text: 'У мене стабільно багато замовлень на ручну роботу, але немає вільних годин. Не можу брати більше клієнтів. Хочу зрозуміти, які товари можна пропонувати покупцям без збільшення часу на виготовлення.',
    reply_to: null, unsupported: false,
  },
  {
    message_id: '5022', author_ref: 'synthetic-peer-03', date: '2026-09-02T14:10:00.000Z',
    text: 'Я бачив кілька моделей, але конкретні умови залежать від постачальника; перевіряйте їх окремо.',
    reply_to: '5021', unsupported: false,
  },
];

export const syntheticMessages = records.map(message => ({
  ...message,
  unsupported: message.unsupported ? 'SYNTHETIC_OPAQUE_CONTENT' : null,
  link: `https://example.invalid/synthetic/${message.message_id}`,
  // Synthetic stand-in semantic commitment, not a raw-text hash. The separate
  // native-adapter test obtains the actual hash from real GramJS projection.
  content_hash: digest({ kind: 'synthetic_semantic_message', ...message }),
}));

// Researcher-authored synthetic semantic annotations. The keyword route must
// not create or modify these labels. 5016 is a positive own-task recall control
// that uses none of the mission's literal phrases; 5015 repeats 5003 exactly.
// own_task_ids records expressed tasks, not current opportunities: 5001 is later
// followed by 5010's cancellation from the same author in a separate thread.
export const syntheticGold = {
  own_task_ids: ['5001', '5003', '5004', '5005', '5006', '5016', '5018', '5019', '5021'],
  controls: [
    { message_id: '5007', reason: 'seller_quotes_customer_request_not_own_task' },
    { message_id: '5008', reason: 'quoted_request_explicitly_not_author_task' },
    { message_id: '5009', reason: 'profession_and_client_resource_without_own_task' },
    { message_id: '5010', reason: 'later_cancellation_in_other_thread_same_author_as_5001' },
    { message_id: '5012', reason: 'reply_to_opaque_parent_context_incomplete' },
    { message_id: '5013', reason: 'reply_to_missing_parent_context_incomplete' },
    { message_id: '5014', reason: 'normal_unrelated_message_from_same_author_as_5003' },
    { message_id: '5015', reason: 'exact_same_author_text_repeat_of_5003' },
    { message_id: '5016', reason: 'keywordless_own_task_positive_recall_control' },
    { message_id: '5017', reason: 'ordinary_unrelated_message' },
    { message_id: '5020', reason: 'vendor_self_promotion_without_customer_task' },
    { message_id: '5022', reason: 'peer_context_not_a_separate_own_task' },
  ],
};
