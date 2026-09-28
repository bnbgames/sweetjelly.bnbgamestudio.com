// Static collection content, mirrored from the game's ScriptableObjects in
// JellySmash-Unity6/Assets/JellySmash/Collection/Resources/Collection/.
// Update this file when an album, set, sticker or pack changes in the game.

export const RARITY = ['Common', 'Rare', 'Epic', 'Legendary'];

export const ALBUM = {
  id: 'sweet_origins',
  name: 'Sweet Origins',
  seasonEndUtc: '2026-10-01T00:00:00Z',
  reward: { coins: 1000, gems: 40, booster: 'Rainbow', boosterCount: 5, cosmetic: 'badge_sweet_origins' },
};

// Slots 00-02 Common, 03-04 Rare, 05 Epic (Legendary in fruit_grove / candy_lab).
const SETS_RAW = [
  ['fruit_grove', 'Fruit Grove', 1500, 0, 'Bomb', 1, 'title_fruit_grove', 3,
    ['Sir Crunch', 'Hammock Banana', 'Sunny Slice', 'Picnic Melon', 'Captain Pineapple', 'The Golden Grove']],
  ['candy_lab', 'Candy Lab', 1500, 0, 'Stripes', 1, 'title_candy_lab', 3,
    ['Beaker Bonbon', 'Gummy Vials', 'Lolli-Scope', 'Fizz Flask', 'Sweet-Bot', 'Professor Gummy']],
  ['jelly_friends', 'Jelly Friends', 2000, 5, 'Packages', 1, 'title_jelly_friends', 2,
    ['Ruby Wobble', 'Minty Bounce', 'Jelly Cat', 'Twin Jellies', 'Party Jelly', 'The Jelly King']],
  ['choco_valley', 'Choco Valley', 2000, 0, 'Rainbow', 2, 'title_choco_valley', 2,
    ['Choco Square', 'Choco-Chip', 'Cocoa Cup', 'Choco Fountain', 'Choco Bunny', 'Cocoa Castle']],
  ['berry_hills', 'Berry Hills', 2500, 5, 'Bomb', 2, 'title_berry_hills', 2,
    ['Strawbuddy', 'Berry Trio', 'Razz', 'Berry Smoothie', 'Berry Fairy', 'Berry Balloon']],
  ['caramel_coast', 'Caramel Coast', 2500, 0, 'Stripes', 2, 'title_caramel_coast', 2,
    ['Caramel Cube', 'Drizzle Wave', 'Toffee Crab', 'Sand Castle', 'Taffy Surfer', 'Caramel Lighthouse']],
  ['mint_meadow', 'Mint Meadow', 3500, 10, 'Packages', 3, 'title_mint_meadow', 2,
    ['Mint Leaf', 'Mint Swirl', 'Mint Flutter', 'Mint Tea', 'Mint Sheep', 'Crystal Falls']],
  ['royal_sweets', 'Royal Sweets', 5000, 10, 'Rainbow', 3, 'title_royal_sweets', 2,
    ['Gem Ring', 'Spoon Scepter', 'Crown Cake', 'Royal Pudding', 'Macaron Carriage', 'The Palace Throne']],
];

export const SETS = SETS_RAW.map(([id, name, coins, gems, booster, boosterCount, cosmetic, topRarity, names], index) => ({
  id, name, index,
  reward: { coins, gems, booster, boosterCount, cosmetic },
  stickers: names.map((displayName, slot) => ({
    id: `${ALBUM.id}.${id}.${String(slot).padStart(2, '0')}`,
    setId: id,
    slot,
    name: displayName,
    rarity: slot <= 2 ? 0 : slot <= 4 ? 1 : topRarity,
  })),
}));

export const STICKERS = SETS.flatMap(s => s.stickers);
export const STICKER_BY_ID = Object.fromEntries(STICKERS.map(s => [s.id, s]));
export const SET_BY_ID = Object.fromEntries(SETS.map(s => [s.id, s]));

// weights: Common / Rare / Epic / Legendary
export const PACKS = {
  standard: { name: 'Standard Pack', stickers: 3, weights: [70, 23, 6, 1], coinCost: 1500, stardustCost: 0, dailyCap: 3, pity: 20 },
  premium: { name: 'Premium Pack', stickers: 5, weights: [55, 30, 12, 3], coinCost: 0, stardustCost: 0, dailyCap: 0, guarantee: 'Rare+' },
  golden: { name: 'Golden Pack', stickers: 5, weights: [40, 35, 20, 5], coinCost: 5000, stardustCost: 500, dailyCap: 1, guarantee: 'Epic+' },
  setfocus: { name: 'Set-Focus Pack', stickers: 3, weights: [70, 23, 6, 1], coinCost: 0, stardustCost: 150, dailyCap: 0 },
};

export const STARDUST = {
  duplicateYield: [2, 8, 25, 100],
  directBuyCost: [90, 270, 900, 3600],
};

export const COSMETIC_NAMES = {
  badge_sweet_origins: 'Sweet Origins Champion',
  title_fruit_grove: 'Grove Keeper',
  title_candy_lab: 'Mad Confectioner',
  title_jelly_friends: 'Jelly Whisperer',
  title_choco_valley: 'Choco Baron',
  title_berry_hills: 'Berry Baron',
  title_caramel_coast: 'Caramel Captain',
  title_mint_meadow: 'Mint Monarch',
  title_royal_sweets: 'Sweet Sovereign',
  ...Object.fromEntries(SETS.map(s => [`avatar_${s.id}`, `${s.name} avatar`])),
};

// Collection unlocks at this ReachedLevel unless config/collection overrides it.
export const DEFAULT_UNLOCK_LEVEL = 12;
export const DEFAULT_CLAIM_GRACE_DAYS = 3;
export const TOTAL_LEVELS = 4400;

// HMAC key the game signs collection saves with (SaveIntegrity.cs).
export const COLLECTION_HMAC_KEY = 'JellySmash.Collection.v1';
