"""
Rubricator: maps raw OSM POI tags to one of ~28 human categories, same approach
as the previous session's rubricator.py (recreated from the documented schema
in sofia-full-city-extraction-results.md — a ~200-entry OSM tag -> rubric
dictionary, tuned iteratively to keep the "other" bucket small).
"""

# rubric name -> set of (key, value) pairs that map to it. A POI matches the
# first rubric whose set contains one of its tags (amenity/shop/office/tourism/leisure).
RUBRICS = {
    "Банки и финансы": {
        ("amenity", "bank"), ("amenity", "bureau_de_change"), ("amenity", "atm"),
        ("office", "financial"), ("office", "insurance"), ("office", "financial_advisor"),
    },
    "Еда и напитки": {
        ("amenity", "restaurant"), ("amenity", "cafe"), ("amenity", "fast_food"),
        ("amenity", "bar"), ("amenity", "pub"), ("amenity", "ice_cream"),
        ("amenity", "food_court"), ("amenity", "biergarten"), ("shop", "bakery"),
        ("shop", "confectionery"), ("shop", "coffee"), ("shop", "deli"),
        ("shop", "pastry"), ("shop", "tea"),
    },
    "Продукты": {
        ("shop", "supermarket"), ("shop", "convenience"), ("shop", "grocery"),
        ("shop", "greengrocer"), ("shop", "butcher"), ("shop", "seafood"),
        ("shop", "farm"), ("shop", "wine"), ("shop", "alcohol"), ("shop", "dairy"),
        ("shop", "cheese"), ("shop", "frozen_food"), ("shop", "health_food"),
    },
    "Одежда и обувь": {
        ("shop", "clothes"), ("shop", "shoes"), ("shop", "boutique"),
        ("shop", "fashion_accessories"), ("shop", "bag"), ("shop", "leather"),
        ("shop", "fabric"), ("shop", "tailor"),
    },
    "Аптеки и здоровье": {
        ("amenity", "pharmacy"), ("shop", "chemist"), ("shop", "medical_supply"),
        ("shop", "optician"), ("healthcare", "pharmacy"),
    },
    "Медицина": {
        ("amenity", "hospital"), ("amenity", "clinic"), ("amenity", "doctors"),
        ("amenity", "dentist"), ("amenity", "veterinary"), ("healthcare", "clinic"),
        ("healthcare", "hospital"), ("healthcare", "dentist"), ("healthcare", "doctor"),
    },
    "Красота и уход": {
        ("shop", "hairdresser"), ("shop", "beauty"), ("shop", "cosmetics"),
        ("shop", "massage"), ("shop", "tattoo"), ("shop", "nail_salon"),
        ("amenity", "spa"),
    },
    "Образование": {
        ("amenity", "school"), ("amenity", "university"), ("amenity", "college"),
        ("amenity", "kindergarten"), ("amenity", "language_school"),
        ("amenity", "driving_school"), ("amenity", "music_school"),
        ("amenity", "library"),
    },
    "Госучреждения": {
        ("office", "government"), ("amenity", "townhall"), ("amenity", "courthouse"),
        ("amenity", "police"), ("amenity", "fire_station"), ("amenity", "post_office"),
        ("amenity", "embassy"), ("office", "diplomatic"),
    },
    "Культура и досуг": {
        ("amenity", "theatre"), ("amenity", "cinema"), ("tourism", "museum"),
        ("tourism", "gallery"), ("amenity", "arts_centre"), ("amenity", "community_centre"),
        ("amenity", "nightclub"), ("amenity", "casino"), ("leisure", "amusement_arcade"),
    },
    "Спорт и отдых": {
        ("leisure", "fitness_centre"), ("leisure", "sports_centre"), ("leisure", "stadium"),
        ("leisure", "swimming_pool"), ("leisure", "pitch"), ("leisure", "golf_course"),
        ("shop", "sports"), ("shop", "bicycle"), ("leisure", "dance"),
    },
    "Авто и мото": {
        ("shop", "car"), ("shop", "car_repair"), ("shop", "car_parts"),
        ("shop", "motorcycle"), ("shop", "tyres"), ("amenity", "car_wash"),
        ("amenity", "car_rental"), ("shop", "fuel"), ("amenity", "fuel"),
    },
    "Строительство и ремонт": {
        ("shop", "hardware"), ("shop", "doityourself"), ("shop", "trade"),
        ("shop", "electrical"), ("shop", "paint"), ("shop", "tiles"),
        ("craft", "electrician"), ("craft", "plumber"), ("craft", "carpenter"),
    },
    "Дом и сад": {
        ("shop", "furniture"), ("shop", "interior_decoration"), ("shop", "garden_centre"),
        ("shop", "florist"), ("shop", "houseware"), ("shop", "appliance"),
    },
    "Электроника и техника": {
        ("shop", "electronics"), ("shop", "mobile_phone"), ("shop", "computer"),
        ("shop", "hifi"), ("shop", "photo"),
    },
    "Книги и канцтовары": {
        ("shop", "books"), ("shop", "stationery"), ("shop", "newsagent"), ("shop", "gift"),
    },
    "Товары для детей": {
        ("shop", "baby_goods"), ("shop", "toys"),
    },
    "Товары для животных": {
        ("shop", "pet"), ("shop", "pet_grooming"),
    },
    "Ювелирные и часы": {
        ("shop", "jewelry"), ("shop", "watches"),
    },
    "Гостиницы и туризм": {
        ("tourism", "hotel"), ("tourism", "hostel"), ("tourism", "guest_house"),
        ("tourism", "apartment"), ("tourism", "information"), ("tourism", "attraction"),
        ("tourism", "viewpoint"),
    },
    "Религия": {
        ("amenity", "place_of_worship"),
    },
    "Транспортные услуги": {
        ("amenity", "taxi"), ("amenity", "bicycle_rental"), ("shop", "car_rental"),
        ("amenity", "charging_station"),
    },
    "Логистика и почта": {
        ("shop", "storage_rental"), ("office", "logistics"), ("amenity", "courier"),
    },
    "Юридические и деловые услуги": {
        ("office", "lawyer"), ("office", "notary"), ("office", "accountant"),
        ("office", "consulting"), ("office", "estate_agent"), ("office", "company"),
        ("office", "coworking"),
    },
    "IT и связь": {
        ("office", "it"), ("office", "telecommunication"), ("shop", "telecommunication"),
    },
    "Мебель и хозтовары (рынки)": {
        ("shop", "mall"), ("shop", "department_store"), ("shop", "variety_store"),
        ("shop", "wholesale"), ("shop", "second_hand"), ("shop", "charity"),
    },
    "Химчистки и бытовые услуги": {
        ("shop", "laundry"), ("shop", "dry_cleaning"), ("craft", "shoemaker"),
        ("craft", "tailor"), ("shop", "funeral_directors"), ("amenity", "funeral_hall"),
    },
    "Прочие услуги": {
        ("shop", "yes"), ("office", "yes"), ("office", "association"), ("office", "ngo"),
        ("office", "educational_institution"),
    },
}

_LOOKUP = {}
for rubric, pairs in RUBRICS.items():
    for pair in pairs:
        _LOOKUP[pair] = rubric

_KEYS = ("amenity", "shop", "office", "tourism", "leisure", "craft", "healthcare")


def classify(tags):
    """Return (rubric_name, matched_key, matched_value) for a tag dict, or
    ("Прочее", key, value) for the first relevant key/value pair found with no match."""
    first = None
    for key in _KEYS:
        if key in tags:
            value = tags[key]
            if first is None:
                first = (key, value)
            rubric = _LOOKUP.get((key, value))
            if rubric:
                return rubric, key, value
    if first:
        return "Прочее", first[0], first[1]
    return "Прочее", "", ""


def classify_stop(tags):
    if tags.get("station") == "subway" or tags.get("subway") == "yes":
        return "subway"
    if tags.get("railway") in ("tram_stop",):
        return "tram_stop"
    if tags.get("railway") in ("station", "halt"):
        return "rail"
    if tags.get("aeroway") == "aerodrome":
        return "airport"
    if tags.get("amenity") == "bus_station":
        return "bus_terminal"
    if tags.get("highway") == "bus_stop" or tags.get("public_transport") in ("platform", "stop_position"):
        return "bus_stop"
    return "other"
