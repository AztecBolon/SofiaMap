// Районна администрация contacts, per official raion (house-page-template
// §13.6/§13.11) — keyed by the same raion name `raionsDirectory.js`
// produces from the boundary file, so a house's `findRaion()` result can
// look a contact up directly by name.
//
// Source: sofia.bg/en/adresi-rajoni (fetched 2026-09-06) — one static
// table of all 24 raions with mayor name + address; that page does NOT
// list phone numbers (they're on each raion's own separate sub-site,
// 24 different domains, not one consolidated source) — so `phone` is
// deliberately absent here rather than guessed or left as a fake "call
// the city" placeholder. If phone numbers get collected later, add a
// `phone` field per entry; nothing else needs to change.
const CONTACTS = {
  "Банкя": { mayor: "Рангел Вълев Марков", address: "гр. Банкя, ул. „Цар Симеон“ № 1" },
  "Витоша": { mayor: "Зарко Калинов Клинков", address: "гр. София, кв. „Павлово“, ул. „Слънце“ № 2" },
  "Връбница": { mayor: "Румен Любомиров Костадинов", address: "гр. София, бул. „Хан Кубрат“, бл. 328, вх. Б" },
  "Възраждане": { mayor: "Станислав Иванов Илиев", address: "гр. София, бул. „Александър Стамболийски“ № 62" },
  "Изгрев": { mayor: "Делян Младенов Георгиев", address: "гр. София, ул. „Атанас Далчев“ № 12" },
  "Илинден": { mayor: "Емил Валентинов Бранчевски", address: "гр. София, ул. „Билянини извори“ № 10" },
  "Искър": { mayor: "Петко Христов Краев", address: "гр. София, бул. „Кръстю Пастухов“ № 18" },
  "Красна Поляна": { mayor: "Димитър Георгиев Петров", address: "гр. София, бул. „Освобождение“ № 25" },
  "Красно Село": { mayor: "Цвета Георгиева Николаева", address: "гр. София, бул. „Цар Борис III“ № 124" },
  "Кремиковци": { mayor: "Лилия Петрова Донкова", address: "гр. София, кв. Ботунец, ул. „Челопешко шосе“ № 267" },
  "Лозенец": { mayor: "Константин Петров Павлов", address: "гр. София, бул. „Васил Левски“ № 2" },
  "Люлин": { mayor: "Георги Емилов Тодоров", address: "гр. София, бул. „Захари Стоянов“ № 15" },
  "Младост": { mayor: "Ивайло Георгиев Кукурин", address: "гр. София, бул. „Свето Преображение“ № 1" },
  "Надежда": { mayor: "Димитър Александров Димов", address: "гр. София, ж.к. „Надежда-2“, ул. „Осми март“ № 6" },
  "Нови Искър": { mayor: "Владислав Владимиров Владимиров", address: "гр. Нови Искър, ул. „Искърско дефиле“ № 121" },
  "Оборище": { mayor: "Георги Тодоров Кузмов", address: "гр. София, бул. „Мадрид“ № 1" },
  "Овча Купел": { mayor: "Ангел Георгиев Стефанов", address: "гр. София, ул. „Любляна“ № 50" },
  "Панчарево": { mayor: "Евгения Бисерова Алексиева", address: "с. Панчарево, ул. „Самоковско шосе“ № 230" },
  "Подуяне": { mayor: "Кристиян Христов Христов", address: "гр. София, ул. „Плакалница“ № 51" },
  "Сердика": { mayor: "Момчил Златков Даскалов", address: "гр. София, бул. „Княгиня Мария Луиза“ № 88" },
  "Слатина": { mayor: "Георги Пламенов Илиев", address: "гр. София, бул. „Шипченски проход“ № 67" },
  "Средец": { mayor: "Трайчо Димитров Трайков", address: "гр. София, ул. „Леге“ № 6" },
  "Студентски": { mayor: "Петко Горанов Горанов", address: "гр. София, ж.к. „Студентски град“, бл. 5" },
  "Триадица": { mayor: "Димитър Петров Божилов", address: "гр. София, ул. „Алабин“ № 54" },
};

function getByRaionName(name) {
  return CONTACTS[name] || null;
}

module.exports = { getByRaionName };
