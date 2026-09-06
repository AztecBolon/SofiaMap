// Human-readable Russian label for an OSM `building=*` value, used ONLY as
// a last-resort display name for a building that has neither its own name
// tag nor a housenumber (see coord.js hit-test and search.js toResult()).
//
// Before this existed, that case fell back to just the nearest street name
// alone (`addr_street` — itself often backfilled from `street_resolved`,
// see claude/address-coverage.md) presented as if it were the object's
// name. That's harmless for an ordinary unnumbered residential building —
// "ul. X" reads fine as a rough location — but for a large, distinctive,
// unnamed landmark (a stadium, a hospital complex, a school) it reads as a
// fabricated postal address for something that obviously isn't addressed
// that way, which is exactly what a user spotted (a running-track stadium
// in Borisova Garden, OSM relation 1028000, tagged `building=stadium` with
// literally no `name` tag anywhere on it or nearby — confirmed by direct
// PBF inspection, not a parser bug). The parallel here is deliberate: this
// mirrors `HIGHWAY_KIND` in map-search.js, added for the same reason on the
// road side ("a misleading 'street with no name'").
const BUILDING_KIND = {
  stadium: "Стадион", sports_centre: "Спортивный комплекс",
  hospital: "Больница", clinic: "Медицинский центр",
  school: "Школа", kindergarten: "Детский сад", university: "Университет", college: "Колледж",
  government: "Административное здание", civic: "Общественное здание",
  church: "Церковь", chapel: "Часовня", cathedral: "Собор", mosque: "Мечеть", synagogue: "Синагога", temple: "Храм",
  train_station: "Ж/д вокзал", transportation: "Транспортное сооружение",
  hotel: "Гостиница",
  industrial: "Промышленное здание", warehouse: "Склад", commercial: "Коммерческое здание",
  retail: "Торговое здание", office: "Офисное здание", service: "Служебное здание",
  garage: "Гараж", garages: "Гаражи", carport: "Навес для машины", shed: "Хозпостройка",
  guardhouse: "Проходная", kiosk: "Киоск", greenhouse: "Теплица", livestock: "Хозпостройка",
  parking: "Паркинг", bunker: "Бункер", ruins: "Руины", construction: "Стройка",
  apartments: "Жилой дом", residential: "Жилое здание", house: "Дом", detached: "Дом",
  semidetached_house: "Дом на две семьи", terrace: "Дом рядовой застройки", bungalow: "Дом", roof: "Навес",
};

// `building` may be "yes" (the OSM default when the mapper didn't specify a
// more precise value) or any value absent from the table above — "Здание"
// (a plain, honest "Building") is the correct fallback for both: it never
// claims more than we actually know.
function buildingKindLabel(building) {
  return BUILDING_KIND[building] || "Здание";
}

module.exports = { BUILDING_KIND, buildingKindLabel };
