pub const ADJECTIVES: [&str; 128] = [
    "Agile", "Amber", "Amiable", "Astute", "Arctic", "Artful", "Autumn", "Azure", "Balmy",
    "Beaming", "Blissful", "Bold", "Bouncy", "Brave", "Breezy", "Bright", "Brisk", "Bubbly",
    "Buoyant", "Calm", "Candid", "Carefree", "Charming", "Cheerful", "Chipper", "Classy", "Clever",
    "Coastal", "Cordial", "Cosmic", "Cozy", "Crimson", "Curious", "Dapper", "Daring", "Dazzling",
    "Dreamy", "Eager", "Earnest", "Elated", "Electric", "Elegant", "Epic", "Fabled", "Fair",
    "Fearless", "Festive", "Fluent", "Fond", "Friendly", "Frosty", "Gallant", "Gentle", "Gilded",
    "Glad", "Gleaming", "Glowing", "Golden", "Graceful", "Grand", "Happy", "Hardy", "Harmonic",
    "Hearty", "Helpful", "Honest", "Hopeful", "Humble", "Jaunty", "Jolly", "Jovial", "Joyful",
    "Keen", "Kind", "Lively", "Loyal", "Lucky", "Lunar", "Magic", "Mellow", "Merry", "Mighty",
    "Misty", "Modest", "Mossy", "Nimble", "Noble", "Northern", "Ocean", "Peppy", "Placid",
    "Playful", "Plucky", "Polite", "Proud", "Quick", "Quiet", "Radiant", "Rapid", "Ready", "Regal",
    "Rosy", "Royal", "Rustic", "Serene", "Silver", "Sincere", "Snowy", "Solar", "Sparkly",
    "Spirited", "Steady", "Stellar", "Sterling", "Sunny", "Swift", "Tidy", "Tranquil", "Trusty",
    "Upbeat", "Valiant", "Velvet", "Vivid", "Warm", "Wise", "Witty", "Zany", "Zesty",
];

pub const ANIMALS: [&str; 128] = [
    "Albatross",
    "Alpaca",
    "Antelope",
    "Armadillo",
    "Badger",
    "Beaver",
    "Bison",
    "Bluebird",
    "Bobcat",
    "Buffalo",
    "Bunny",
    "Butterfly",
    "Camel",
    "Canary",
    "Capybara",
    "Caribou",
    "Cheetah",
    "Chickadee",
    "Chinchilla",
    "Chipmunk",
    "Cockatoo",
    "Condor",
    "Cardinal",
    "Cougar",
    "Coyote",
    "Crane",
    "Cricket",
    "Dingo",
    "Dolphin",
    "Dove",
    "Dragonfly",
    "Duckling",
    "Eagle",
    "Egret",
    "Elephant",
    "Elk",
    "Falcon",
    "Fawn",
    "Ferret",
    "Finch",
    "Firefly",
    "Flamingo",
    "Fox",
    "Gazelle",
    "Gecko",
    "Gibbon",
    "Giraffe",
    "Goldfinch",
    "Gopher",
    "Gorilla",
    "Grouse",
    "Hare",
    "Hawk",
    "Hedgehog",
    "Heron",
    "Hummingbird",
    "Ibex",
    "Ibis",
    "Iguana",
    "Impala",
    "Jackrabbit",
    "Jaguar",
    "Jay",
    "Kangaroo",
    "Kestrel",
    "Kingfisher",
    "Kitten",
    "Kiwi",
    "Koala",
    "Ladybug",
    "Lark",
    "Lemur",
    "Leopard",
    "Lion",
    "Llama",
    "Lobster",
    "Lynx",
    "Macaw",
    "Magpie",
    "Manatee",
    "Marmot",
    "Marten",
    "Meerkat",
    "Mink",
    "Mongoose",
    "Moose",
    "Narwhal",
    "Newt",
    "Nightingale",
    "Ocelot",
    "Octopus",
    "Oriole",
    "Osprey",
    "Ostrich",
    "Otter",
    "Owl",
    "Panda",
    "Panther",
    "Parrot",
    "Pelican",
    "Penguin",
    "Pheasant",
    "Platypus",
    "Puffin",
    "Puma",
    "Quail",
    "Quokka",
    "Rabbit",
    "Raccoon",
    "Raven",
    "Reindeer",
    "Robin",
    "Salmon",
    "Seahorse",
    "Seal",
    "Sparrow",
    "Squirrel",
    "Starling",
    "Stork",
    "Swallow",
    "Swan",
    "Tiger",
    "Toucan",
    "Turtle",
    "Walrus",
    "Whale",
    "Wombat",
    "Wren",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnonymousIdentity {
    pub name: String,
    pub colors: [String; 3],
    pub angle: u32,
}

fn fnv1a32(text: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in text.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

struct Sequence(u32);

impl Sequence {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_add(0x9e37_79b9);
        let mut z = self.0;
        z = (z ^ (z >> 16)).wrapping_mul(0x85eb_ca6b);
        z = (z ^ (z >> 13)).wrapping_mul(0xc2b2_ae35);
        z ^ (z >> 16)
    }
}

pub fn hsl_hex(hue: f64, saturation: f64, lightness: f64) -> String {
    let s = saturation / 100.0;
    let l = lightness / 100.0;
    let k = |n: f64| (n + hue / 30.0) % 12.0;
    let a = s * l.min(1.0 - l);
    let channel = |n: f64| l - a * (k(n) - 3.0).min(9.0 - k(n)).clamp(-1.0, 1.0);
    let hex = |v: f64| format!("{:02x}", (v * 255.0).round() as i64);
    format!(
        "#{}{}{}",
        hex(channel(0.0)),
        hex(channel(8.0)),
        hex(channel(4.0))
    )
}

fn gradient_stop(hue: i64, saturation: i64, lightness: i64) -> String {
    let h = (hue + 360).rem_euclid(360);
    let bright = (45..=200).contains(&h);
    hsl_hex(
        h as f64,
        saturation as f64,
        if bright { lightness - 10 } else { lightness } as f64,
    )
}

pub fn anonymous_identity(id: &str) -> AnonymousIdentity {
    let mut seq = Sequence(fnv1a32(&id.trim().to_lowercase()));
    let adjective = ADJECTIVES[seq.next() as usize % ADJECTIVES.len()];
    let animal = ANIMALS[seq.next() as usize % ANIMALS.len()];
    let hue = i64::from(seq.next() % 360);
    let spread = 28 + i64::from(seq.next() % 30);
    let direction = if seq.next() % 2 == 1 { 1 } else { -1 };
    let saturation = 68 + i64::from(seq.next() % 18);
    let lightness = 54 + i64::from(seq.next() % 10);
    AnonymousIdentity {
        name: format!("{adjective} {animal}"),
        colors: [
            gradient_stop(hue, saturation, lightness),
            gradient_stop(hue + direction * spread, saturation, lightness + 4),
            gradient_stop(hue + direction * spread * 2, saturation - 6, lightness - 4),
        ],
        angle: seq.next() % 360,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_stable_and_case_insensitive() {
        let a = anonymous_identity("ABC-123");
        let b = anonymous_identity(" abc-123 ");
        assert_eq!(a, b);
        assert!(a.name.contains(' '));
        assert!(a.colors.iter().all(|c| c.len() == 7 && c.starts_with('#')));
        assert!(a.angle < 360);
        assert_eq!(hsl_hex(0.0, 100.0, 50.0), "#ff0000");
        assert_eq!(hsl_hex(120.0, 100.0, 50.0), "#00ff00");
    }
}
