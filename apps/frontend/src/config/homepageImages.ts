import catAccessories from "../assets/images/cat-accessories.jpg";
import catLaptops from "../assets/images/cat-laptops.jpg";
import catMobiles from "../assets/images/cat-mobiles.jpg";
import catTablets from "../assets/images/cat-tablets.jpg";
import heroIphone from "../assets/images/hero-iphone.png";
import heroLaptop from "../assets/images/hero-laptop.png";
import heroTablet from "../assets/images/hero-tablet.png";

export type HomepageImage = {
  name: string;
  src: string;
  alt: string;
  objectPosition: string;
};

// Replace an image by importing another file from ../assets/images and updating
// its entry here. Keep the alt text and object position accurate for the image.
export const CATEGORY_IMAGES: Record<string, HomepageImage> = {
  mobiles: {
    name: "Mobiles",
    src: catMobiles,
    alt: "Three smartphones in silver, dark, and blue finishes.",
    objectPosition: "50% 50%",
  },
  laptops: {
    name: "Laptops",
    src: catLaptops,
    alt: "A laptop displaying a colorful wave wallpaper.",
    objectPosition: "50% 50%",
  },
  tablets: {
    name: "Tablets",
    src: catTablets,
    alt: "Three tablets with teal, pink, and dark screens.",
    objectPosition: "50% 50%",
  },
  smartwatches: {
    name: "Smartwatches",
    src: "/categories/smartwatches-photo.jpg",
    alt: "A smartwatch shown close up.",
    objectPosition: "50% 46%",
  },
  accessories: {
    name: "Accessories",
    src: catAccessories,
    alt: "Wireless earbuds with a charging case, power bank, and cable.",
    objectPosition: "50% 50%",
  },
};

export const HERO_IMAGES: readonly HomepageImage[] = [
  {
    name: "iPhone hero",
    src: heroIphone,
    alt: "Purple iPhone shown from the front and back.",
    objectPosition: "50% 50%",
  },
  {
    name: "Tablet hero",
    src: heroTablet,
    alt: "Tablet shown from the front and back.",
    objectPosition: "50% 50%",
  },
  {
    name: "Laptop hero",
    src: heroLaptop,
    alt: "Laptop shown open with its colorful screen.",
    objectPosition: "50% 50%",
  },
];
