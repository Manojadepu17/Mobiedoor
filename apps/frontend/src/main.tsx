import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowRight, BadgeCheck, ChevronDown, ChevronRight, CircleCheck, CircleHelp, Clock3,
  Facebook, Instagram, Leaf, Linkedin, Menu, PackageCheck, Recycle, Search, ShieldCheck,
  Sparkles, Truck, X, Wrench, Youtube, LogOut, LayoutDashboard, Plus, Trash2, Users, type LucideIcon,
} from "lucide-react";
import Cropper, { type Area, type Point } from "react-easy-crop";
import { adminPricesToPaise, discountPercent, formatInr, paiseToInr } from "./price";
import { ALL_DEVICES_CATEGORY, clearShopFilters, productsQuery, readShopFilters, readShopPage, SHOP_ROUTE, updateShopFilter, updateShopPage } from "./shop-state";
import { ProductDetailContent } from "./product-details";
import { CataloguePagination, CatalogueStatus } from "./catalogue-components";
import "./styles.css";

const queryClient = new QueryClient();
const configuredApiUrl = import.meta.env.VITE_API_URL?.trim();
if (import.meta.env.PROD && configuredApiUrl !== "/api") {
  throw new Error('VITE_API_URL must be exactly "/api" in production.');
}
const API_URL = (configuredApiUrl ?? "http://localhost:4000").replace(/\/+$/, "");

function apiRequestUrl(path: string) {
  const normalizedPath = `/${path.replace(/^\/+/, "")}`;
  const baseHasApiPrefix = API_URL === "/api" || API_URL.endsWith("/api");
  const requestPath = baseHasApiPrefix && (normalizedPath === "/api" || normalizedPath.startsWith("/api/"))
    ? normalizedPath.slice(4) || "/"
    : normalizedPath;
  return `${API_URL}${requestPath}`;
}

type Product = {
  id: string; name: string; slug: string; sku?: string; brand: string; model: string;
  description: string; priceInPaise: number; originalPriceInPaise?: number | null;
  condition: "LIKE_NEW" | "EXCELLENT" | "GOOD" | "FAIR"; category: string;
  stockQuantity: number; warrantyMonths?: number; imageUrls: string[]; specifications?: unknown; availability?: "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK"; isPublished?: boolean;
};

type ApiEnvelope<T> = { data: T; meta?: { page: number; limit: number; total: number; totalPages: number }; message?: string };
type AuthUser = { id: string; name: string; email: string; role: "FOUNDER" | "ADMIN" | "STAFF" | "CUSTOMER" };

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiRequest<T>(path: string, options?: RequestInit): Promise<ApiEnvelope<T>> {
  const isFormData = options?.body instanceof FormData;
  const response = await fetch(apiRequestUrl(path), {
    ...options,
    credentials: "include",
    headers: { ...(isFormData ? {} : { "Content-Type": "application/json" }), ...(options?.headers ?? {}) },
  });
  if (response.status === 204) return { data: null as T };
  const body = await response.json() as ApiEnvelope<T> & { error?: { message?: string } };
  if (!response.ok) throw new ApiError(body.error?.message ?? "The request could not be completed.", response.status);
  return body;
}

function createCroppedImage(source: string, crop: Area | undefined, rotation: number) {
  return new Promise<Blob>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) { reject(new Error("Your browser cannot prepare this image.")); return; }
      const radians = rotation * Math.PI / 180;
      const boundingWidth = Math.abs(Math.cos(radians) * image.width) + Math.abs(Math.sin(radians) * image.height);
      const boundingHeight = Math.abs(Math.sin(radians) * image.width) + Math.abs(Math.cos(radians) * image.height);
      canvas.width = boundingWidth;
      canvas.height = boundingHeight;
      context.translate(boundingWidth / 2, boundingHeight / 2);
      context.rotate(radians);
      context.drawImage(image, -image.width / 2, -image.height / 2);
      const cropped = document.createElement("canvas");
      const activeCrop = crop ?? { x: 0, y: 0, width: image.width, height: image.height };
      cropped.width = activeCrop.width;
      cropped.height = activeCrop.height;
      cropped.getContext("2d")?.drawImage(canvas, activeCrop.x, activeCrop.y, activeCrop.width, activeCrop.height, 0, 0, activeCrop.width, activeCrop.height);
      cropped.toBlob(blob => blob ? resolve(blob) : reject(new Error("The cropped image could not be prepared.")), "image/jpeg", 0.9);
    };
    image.onerror = () => reject(new Error("The selected image could not be read."));
    image.src = source;
  });
}

const shopCategories = [
  { value: "mobiles", label: "Mobiles", image: "https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=1000&q=85" },
  { value: "laptops", label: "Laptops", image: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?auto=format&fit=crop&w=1000&q=85" },
  { value: "tablets", label: "Tablets", image: "https://images.unsplash.com/photo-1544244015-0df4b3ffc6b0?auto=format&fit=crop&w=1000&q=85" },
] as const;

const services = [
  { icon: Recycle, eyebrow: "Give devices a second life", title: "Device collection", text: "Turn unused technology into value with a simple, transparent collection experience." },
  { icon: Wrench, eyebrow: "Carefully restored", title: "Refurbishment", text: "Our technicians restore each device with the precision it deserves, never cutting corners." },
  { icon: ShieldCheck, eyebrow: "Confidence included", title: "Quality verification", text: "Every device passes a multi-point diagnostic before it earns the MobieDoor mark." },
];

const lifecycleStages = [
  { label: "Collect", text: "Gather pre-owned devices from individuals, businesses, and institutions.", icon: Recycle },
  { label: "Diagnostics", text: "Carefully inspect devices and assess their condition.", icon: Search },
  { label: "Refurbishment", text: "Repair devices, replace components, and restore functionality.", icon: Wrench },
  { label: "Quality check", text: "Test device functionality, reliability, and performance before resale.", icon: ShieldCheck },
  { label: "Resell & reuse", text: "Return refurbished devices to customers and extend their useful life.", icon: Leaf },
];

function Logo() {
  return <Link to="/" className="brand" aria-label="MobieDoor home"><span className="brand-mark">MD</span><span>mobie<span>door</span></span></Link>;
}

function FallbackImage({ src, alt, className = "" }: { src?: string; alt: string; className?: string }) {
  const [failed, setFailed] = useState(!src);
  return failed
    ? <div className={`image-fallback ${className}`} role="img" aria-label={alt}><PackageCheck size={28} /><span>MobieDoor verified device</span></div>
    : <img className={className} src={src} alt={alt} onError={() => setFailed(true)} />;
}

function RefurbishmentVisual({ className = "" }: { className?: string }) {
  return <div className={`refurbishment-visual ${className}`} role="img" aria-label="MobieDoor technician inspecting a refurbished device"><div className="visual-device"><div className="visual-screen"><PackageCheck size={34} /><span>Verified</span></div><div className="visual-port" /></div><div className="visual-tools"><Wrench size={24} /><ShieldCheck size={24} /><span>Tested with care</span></div><span className="visual-caption">MobieDoor refurbishment workspace</span></div>;
}

function LifecycleSection() {
  return <section className="lifecycle-section" aria-labelledby="lifecycle-title"><div className="container lifecycle-layout"><div className="lifecycle-intro"><p className="eyebrow light">The MobieDoor loop</p><h2 id="lifecycle-title">One device.<br /><em>More useful life.</em></h2><p className="dark-lead">We keep good technology moving through a considered cycle of care, so every handover creates value without creating more waste.</p><div className="lifecycle-proof"><CircleCheck size={17} /><span>Designed to keep devices in circulation</span></div></div><div className="lifecycle-diagram" aria-label="Five-stage device lifecycle"><svg className="lifecycle-orbit" viewBox="0 0 600 600" aria-hidden="true"><defs><marker id="lifecycle-arrow" markerWidth="8" markerHeight="8" refX="5" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" /></marker></defs><circle className="orbit-glow" cx="300" cy="300" r="205" /><path className="orbit-path" d="M300 95 A205 205 0 1 1 299.9 95" markerEnd="url(#lifecycle-arrow)" /></svg><div className="lifecycle-center"><div className="lifecycle-device"><PackageCheck size={35} /><span>MobieDoor</span><small>verified</small></div><span className="lifecycle-center-caption">Care in<br />circulation</span></div><ol className="lifecycle-stages">{lifecycleStages.map(({ label, text, icon: Icon }, index) => <li className={`lifecycle-stage lifecycle-stage-${index + 1}`} key={label}><div className="lifecycle-stage-icon"><Icon size={18} /></div><div><span className="lifecycle-stage-number">0{index + 1}</span><h3>{label}</h3><p>{text}</p></div></li>)}</ol></div></div></section>;
}

function CategoryCard({ category }: { category: typeof shopCategories[number] }) {
  return <Link className="category-card" to={`/devices?category=${category.value}`} aria-label={`Shop ${category.label}`}><div className="category-card-image"><FallbackImage src={category.image} alt="" /></div><h3>{category.label}</h3></Link>;
}

function ShopByCategory() {
  return <section className="section shop-category-section"><div className="container"><SectionHeading eyebrow="The MobieDoor edit" title="Technology worth bringing home." text="Explore our collection by category." /><div className="category-grid">{shopCategories.map(category => <CategoryCard category={category} key={category.value} />)}</div></div></section>;
}

function Newsletter() {
  return <div className="newsletter"><input aria-label="Email address" placeholder="Your email address" type="email" disabled title="Newsletter signup is not available yet" /><button aria-label="Newsletter signup unavailable" type="button" disabled title="Newsletter signup is not available yet"><ArrowRight size={17} /></button></div>;
}

function Header() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const me = useQuery<AuthUser>({ queryKey: ["auth-me"], queryFn: () => apiRequest<AuthUser>("/auth/me").then(result => result.data), retry: false });
  const logout = useMutation({ mutationFn: () => apiRequest<null>("/auth/logout", { method: "POST" }), onSuccess: () => { queryClient.clear(); navigate("/", { replace: true }); } });
  const links = [["Home", "/"], ["Shop devices", SHOP_ROUTE], ["About", "/about"], ["Services", "/services"], ["Contact", "/contact"]];
  return <header className="site-header"><div className="container nav-wrap"><Logo />
    <nav className={`main-nav ${open ? "is-open" : ""}`} aria-label="Primary navigation">
      {links.map(([label, path]) => <NavLink key={path} to={path} onClick={() => setOpen(false)} className={({ isActive }) => isActive ? "active" : ""}>{label}</NavLink>)}
      <Link className="nav-cta" to="/trade-in" onClick={() => setOpen(false)}>Trade in <ArrowRight size={15} /></Link>
      {me.data ? <><Link className="nav-account" to={me.data.role === "CUSTOMER" ? "/account" : me.data.role === "STAFF" ? "/staff" : "/admin"} onClick={() => setOpen(false)}>{me.data.name} <LayoutDashboard size={15} /></Link><button className="nav-logout" type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>{logout.isPending ? "Signing out..." : "Logout"}</button></> : <><Link className="nav-auth" to="/login" onClick={() => setOpen(false)}>Sign In</Link><Link className="nav-cta" to="/register" onClick={() => setOpen(false)}>Register <ArrowRight size={15} /></Link></>}
    </nav>
    <button className="menu-toggle" onClick={() => setOpen(!open)} aria-label={open ? "Close menu" : "Open menu"}>{open ? <X /> : <Menu />}</button>
  </div></header>;
}

function Footer() {
  return <footer className="footer"><div className="container footer-grid">
    <div><Logo /><p className="footer-intro">Better technology, less waste. We make trusted electronics more accessible while keeping them in use for longer.</p><div className="socials"><a href="https://instagram.com" aria-label="Instagram"><Instagram size={17} /></a><a href="https://linkedin.com" aria-label="LinkedIn"><Linkedin size={17} /></a><a href="https://youtube.com" aria-label="YouTube"><Youtube size={17} /></a><a href="https://facebook.com" aria-label="Facebook"><Facebook size={17} /></a></div></div>
    <div><h3>Explore</h3><Link to="/about">Our story</Link><Link to="/services">What we do</Link><Link to={SHOP_ROUTE}>Shop devices</Link><Link to="/how-it-works">How it works</Link></div>
    <div><h3>Work with us</h3><Link to="/trade-in">Trade in a device</Link><Link to="/partnership">Partner with MobieDoor</Link><Link to="/contact">Contact us</Link></div>
    <div><h3>Stay in the loop</h3><p className="footer-small">Thoughtful notes on technology, value and the circular economy.</p><Newsletter /></div>
  </div><div className="container footer-bottom"><span>© 2026 MobieDoor Technologies. Built for a better tomorrow.</span><span>Privacy &nbsp;·&nbsp; Terms</span></div></footer>;
}

function Layout({ children }: { children: React.ReactNode }) { return <><Header /><main>{children}</main><Footer /></>; }
function SectionHeading({ eyebrow, title, text, action }: { eyebrow: string; title: string; text?: string; action?: React.ReactNode }) {
  return <div className="section-heading"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2>{text && <p className="section-lead">{text}</p>}</div>{action}</div>;
}
function Button({ to, children, variant = "primary" }: { to: string; children: React.ReactNode; variant?: "primary" | "outline" | "text" }) {
  return <Link className={`button ${variant}`} to={to}>{children}<ArrowRight size={16} /></Link>;
}
function PageIntro({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return <section className="page-intro"><div className="container narrow"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="intro-text">{text}</p></div></section>;
}

function Home() {
  return <>
    <section className="hero"><div className="container hero-grid"><div className="hero-copy"><p className="eyebrow light">The smarter way to own tech</p>    <h1>Good technology should go further.</h1><p className="hero-text">Premium refurbished devices, thoughtfully restored and ready for their next chapter. Better for your pocket. Better for the planet.</p><div className="hero-actions"><Button to={SHOP_ROUTE}>Explore devices</Button><Button to="/trade-in" variant="outline">Trade in your device</Button></div><div className="hero-proof"><span><CircleCheck size={16} /> 40+ point quality check</span><span><CircleCheck size={16} /> Warranty included</span></div></div><div className="hero-visual"><div className="hero-image">    <FallbackImage src="https://images.unsplash.com/photo-1632661674596-df8be070a5c5?auto=format&fit=crop&w=1200&q=85" alt="Refurbished smartphone on a clean desk" /></div><div className="floating-card"><span className="check-icon"><BadgeCheck size={20} /></span><div><strong>MobieDoor verified</strong><small>Quality you can feel</small></div></div><div className="hero-stamp"><span>Since</span><strong>2026</strong><span>India</span></div></div></div></section>
    <section className="trust-bar"><div className="container trust-items"><span><ShieldCheck size={19} /> Verified quality</span><span><Truck size={19} /> Delivered with care</span><span><Clock3 size={19} /> 6 month warranty</span><span><Leaf size={19} /> Circular by design</span></div></section>
    <ShopByCategory />
    <section className="section soft-section"><div className="container split-section"><RefurbishmentVisual className="section-image" /><div className="split-copy"><p className="eyebrow">Why MobieDoor</p><h2>Renewed, not compromised.</h2><p>We believe choosing refurbished should feel like an upgrade. Every device is assessed, restored and verified by our team before it reaches you.</p><ul className="feature-list"><li><span><PackageCheck size={20} /></span><div><strong>Honest condition grades</strong><small>No vague “like new” claims. Just clear, useful detail.</small></div></li><li><span><Wrench size={20} /></span><div><strong>Technician-led checks</strong><small>Performance, battery, camera and more, tested properly.</small></div></li><li><span><Leaf size={20} /></span><div><strong>A lighter footprint</strong><small>Extending a device's life keeps useful tech in circulation.</small></div></li></ul><Button to="/how-it-works" variant="text">See our process</Button></div></div></section>
    <section className="section"><div className="container"><SectionHeading eyebrow="More than a marketplace" title="A circular system, made human." text="From first collection to final delivery, we put care into every handover." /><div className="service-grid">{services.map(({ icon: Icon, eyebrow, title, text }) => <article className="service-card" key={title}><div className="service-icon"><Icon size={22} /></div><p className="card-eyebrow">{eyebrow}</p><h3>{title}</h3><p>{text}</p><Link to="/services">Learn more <ChevronRight size={16} /></Link></article>)}</div></div></section>
    <LifecycleSection />
    <Testimonials /><Faq />
  </>;
}

function Testimonials() { return <section className="section testimonial-section"><div className="container"><SectionHeading eyebrow="Customer feedback" title="Trust is built through real experiences." text="We will share verified customer feedback here as it is received and approved." /><div className="review-empty-state"><ShieldCheck size={25} /><p>Customer reviews will appear here as verified feedback is received.</p><Link className="button outline" to="/contact">Share your experience <ArrowRight size={16} /></Link></div></div></section>; }
function Faq() { const [open, setOpen] = useState<number | null>(0); const items = [["What does MobieDoor verified mean?", "Every device goes through a structured diagnostic covering display, battery, camera, connectivity, charging and more. We then grade it honestly so you know exactly what to expect."], ["Do refurbished devices come with a warranty?", "Yes. Eligible devices include a six-month limited warranty. The specific coverage is shown clearly on each product detail page."], ["How does trade-in work?", "Tell us about your device using our collection request form. Our team reviews the details, gets in touch with an estimate and arranges the next step."], ["Where do you deliver?", "We are building a reliable delivery network across India, starting with Tier 2 and Tier 3 cities. Reach out if you want to check your pin code."]]; return <section className="section faq-section"><div className="container faq-grid"><div><p className="eyebrow">Questions, answered</p><h2>Clarity is part of the service.</h2><p className="section-lead">Still curious? Our team is happy to help.</p><Button to="/contact" variant="text">Talk to our team</Button></div><div className="faq-list">{items.map(([question, answer], i) => <div className={`faq-item ${open === i ? "open" : ""}`} key={question}><button onClick={() => setOpen(open === i ? null : i)}><span>{question}</span><ChevronDown size={18} /></button>{open === i && <p>{answer}</p>}</div>)}</div></div></section>; }

function About() { return <><PageIntro eyebrow="Our story" title="Making better technology easier to choose." text="MobieDoor exists to make the circular economy feel simple, trustworthy and genuinely useful — starting with the devices we rely on every day." /><section className="section"><div className="container split-section about-split"><div className="split-copy"><p className="eyebrow">A practical kind of optimism</p><h2>There is more life in good technology.</h2><p>India is full of capable devices that are underused, overlooked or discarded too soon. We bring the right people and processes together to give that technology a meaningful second chapter.</p><p>That means reliable devices at fairer prices, better access outside the biggest cities, and fewer resources spent making things we already have.</p><Button to="/services">What we do</Button></div><RefurbishmentVisual className="section-image tall" /></div></section><section className="dark-section"><div className="container values"><p className="eyebrow light">What guides us</p><h2>Trust is built in the details.</h2><div className="value-grid">{[["01", "Be transparent", "Clear condition, clear pricing, clear expectations. Always."], ["02", "Do the work properly", "Quality is not a label we add at the end. It is the process."], ["03", "Keep it moving", "Every device in circulation is a small, practical step forward."]].map(([number, title, text]) => <div key={number}><span>{number}</span><h3>{title}</h3><p>{text}</p></div>)}</div></div></section></>; }

const serviceSteps: Array<{ num: string; title: string; text: string; icon: LucideIcon }> = [
  { num: "01", title: "Collect", text: "We make it easy for individuals, retailers and businesses to put good devices back into circulation.", icon: Recycle },
  { num: "02", title: "Diagnose", text: "Each device is assessed across the details that matter: performance, battery, display, cameras, audio and connectivity.", icon: Search },
  { num: "03", title: "Restore", text: "Our technicians clean, repair and prepare every device with a focus on reliability, not just appearance.", icon: Wrench },
  { num: "04", title: "Redistribute", text: "We match verified technology with people who value quality, access and a smarter way to buy.", icon: Truck },
];
function Services() { return <><PageIntro eyebrow="What we do" title="The full journey of a better device." text="From first inspection to the moment it reaches a new owner, we combine thoughtful operations with genuine technical care." /><section className="section"><div className="container service-list">{serviceSteps.map(({ num, title, text, icon: Icon }) => <article className="service-row" key={num}><span className="service-number">{num}</span><div className="service-row-icon"><Icon size={25} /></div><div><h2>{title}</h2><p>{text}</p></div><ChevronRight className="row-arrow" /></article>)}</div></section><section className="cta-band"><div className="container cta-band-inner"><div><p className="eyebrow light">Ready to make a difference?</p><h2>Let’s keep good technology moving.</h2></div><Button to="/contact" variant="outline">Start a conversation</Button></div></section></>; }

function Products() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: categoryData } = useQuery<string[]>({ queryKey: ["categories"], queryFn: () => apiRequest<string[]>("/categories").then(result => result.data) });
  const { search, category, sort } = readShopFilters(searchParams, categoryData ?? []);
  const page = readShopPage(searchParams);
  const updateFilter = (key: "search" | "category" | "sort", value: string) => {
    setSearchParams(updateShopFilter(searchParams, key, value), { replace: true });
  };
  const { data, isLoading, isError } = useQuery<ApiEnvelope<Product[]>>({
    queryKey: ["products", search, category, sort, page],
    queryFn: () => {
      const query = productsQuery({ search, category, sort }, page).toString();
      return apiRequest<Product[]>(`/products${query ? `?${query}` : ""}`);
    },
    retry: false,
  });
  useEffect(() => {
    const totalPages = data?.meta?.totalPages;
    if (totalPages === undefined) return;
    if (totalPages === 0 && page !== 1) setSearchParams(updateShopPage(searchParams, 1), { replace: true });
    else if (totalPages > 0 && page > totalPages) setSearchParams(updateShopPage(searchParams, totalPages), { replace: true });
  }, [data?.meta?.totalPages, page, searchParams, setSearchParams]);
  const products = data?.data ?? [];
  const hasFilters = Boolean(search.trim() || category !== ALL_DEVICES_CATEGORY);
  const clearFilters = () => setSearchParams(clearShopFilters(searchParams), { replace: true });
  return <><PageIntro eyebrow="The collection" title="Devices with more to give." text="Browse verified technology that has been carefully restored and honestly described. Better value, without the guesswork." /><section className="section catalogue"><div className="container"><div className="catalogue-toolbar"><label className="search-field"><Search size={18} /><input value={search} onChange={e => updateFilter("search", e.target.value)} placeholder="Search by brand or model" /><button type="button" className="clear-search" onClick={() => updateFilter("search", "")} disabled={!search} aria-label="Clear search">×</button></label><div className="filters"><select aria-label="Filter by category" value={category} onChange={e => updateFilter("category", e.target.value)}><option>{ALL_DEVICES_CATEGORY}</option>{(categoryData ?? []).map(item => <option key={item}>{item}</option>)}</select><select aria-label="Sort products" value={sort} onChange={e => updateFilter("sort", e.target.value)}><option>Featured</option><option>Price: low to high</option><option>Price: high to low</option></select></div></div>{isLoading && <CatalogueStatus state="loading" />}{isError && <CatalogueStatus state="error" />}{data && products.length === 0 && <CatalogueStatus state="empty" hasFilters={hasFilters} onClear={clearFilters} />}{data && products.length > 0 && <><div className="product-grid api-products">{products.map(product => <Link className="product-card" to={`/products/${product.slug}`} key={product.id}><div className="product-image"><FallbackImage src={product.imageUrls[0]} alt={product.name} /><span className="condition-tag">{product.condition.replace("_", " ")}</span></div><div className="product-info"><div><h3>{product.name}</h3><p>{product.brand} · {product.model}</p></div><strong>{formatInr(product.priceInPaise)}</strong>{product.originalPriceInPaise && product.originalPriceInPaise > product.priceInPaise && <small className="original-price">{formatInr(product.originalPriceInPaise)} · {discountPercent(product.priceInPaise, product.originalPriceInPaise)}% off</small>}</div></Link>)}</div><CataloguePagination page={page} totalPages={data.meta?.totalPages ?? 1} onPrevious={() => setSearchParams(updateShopPage(searchParams, page - 1), { replace: true })} onNext={() => setSearchParams(updateShopPage(searchParams, page + 1), { replace: true })} /></>}</div></section></>;
}

function ProductDetails() {
  const { slug } = useParams();
  const { data, isLoading, isError } = useQuery<Product>({ queryKey: ["product", slug], queryFn: () => apiRequest<Product>(`/products/${encodeURIComponent(slug ?? "")}`).then(result => result.data), enabled: Boolean(slug), retry: false });
  if (isLoading) return <section className="section detail-page"><div className="container catalogue-state"><Sparkles size={28} /><h2>Loading device details</h2><p>Checking the latest verified information.</p></div></section>;
  if (isError || !data) return <section className="section detail-page"><div className="container catalogue-state pending"><PackageCheck size={28} /><p className="eyebrow">Product detail</p><h1>We could not find that device.</h1><p>It may no longer be available, or the live catalogue is temporarily unavailable.</p><Button to="/products">Back to collection</Button></div></section>;
  return <ProductDetailContent product={data} />;
}

function FormPage({ type }: { type: "trade" | "partner" | "contact" }) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const copy = type === "trade" ? { eyebrow: "Give it another life", title: "Trade in your device.", text: "Tell us a little about the technology you no longer need. We’ll review it carefully and come back with the next step.", action: "Request an estimate", endpoint: "/trade-in" } : type === "partner" ? { eyebrow: "For retailers & businesses", title: "Build a more circular business.", text: "Whether you have devices to move or a customer experience to improve, we’d love to understand what you’re building.", action: "Send partnership enquiry", endpoint: "/partnerships" } : { eyebrow: "We’re here to help", title: "Let’s talk.", text: "Questions about a device, a collection or a potential partnership? Leave us a note and our team will get back to you.", action: "Send message", endpoint: "/enquiries" };
  const mutation = useMutation({ mutationFn: (payload: Record<string, string>) => apiRequest<{ id: string }>(copy.endpoint, { method: "POST", body: JSON.stringify(payload) }), onSuccess: () => { setSent(true); setError(""); }, onError: (submissionError: Error) => { setError(submissionError.message); } });
  const submit = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>; mutation.mutate(values); };
  return <><PageIntro eyebrow={copy.eyebrow} title={copy.title} text={copy.text} /><section className="section form-section"><div className="container form-layout"><div className="form-aside"><div className="service-icon"><CircleCheck size={22} /></div><h2>A considered next step.</h2><p>Your details are sent securely to the MobieDoor team and saved only after the backend confirms receipt.</p><div className="aside-note"><Clock3 size={17} /><span>We typically respond within one business day.</span></div></div><form className="enquiry-form" onSubmit={submit}><div className="form-row"><label>{type === "partner" ? "Company name" : "Your name"}<input name={type === "partner" ? "companyName" : type === "trade" ? "customerName" : "name"} required placeholder={type === "partner" ? "Your company" : "Your full name"} /></label><label>Email address<input name="email" required type="email" placeholder="you@example.com" /></label></div>{type === "partner" && <div className="form-row"><label>Your name<input name="contactName" required placeholder="Contact person" /></label><label>City<input name="city" required placeholder="Where are you based?" /></label></div>}{type === "trade" && <><div className="form-row"><label>City<input name="city" required placeholder="Where are you based?" /></label><label>Device brand<input name="deviceBrand" required placeholder="e.g. Apple, Samsung" /></label></div><div className="form-row"><label>Device model<input name="deviceModel" required placeholder="e.g. iPhone 13" /></label><label>Condition<input name="deviceCondition" required placeholder="e.g. Excellent" /></label></div></>}<label>Phone number<input name="phoneNumber" required type="tel" placeholder="+91 00000 00000" /></label><label>{type === "trade" ? "Tell us about its condition" : "How can we help?"}<textarea name={type === "trade" ? "additionalDescription" : "message"} required rows={5} placeholder={type === "trade" ? "Any details about age, condition or accessories..." : "A little context helps us give you a thoughtful reply..."} /></label><button className="button primary" type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Sending..." : copy.action}<ArrowRight size={16} /></button>{sent && <p className="form-status" role="status">Thanks — your request has been received by MobieDoor.</p>}{error && <p className="form-status form-error" role="alert">{error}</p>}</form></div></section></>; }

function Contact() { return <FormPage type="contact" />; }
function HowItWorks() { const steps: Array<{ title: string; text: string; icon: LucideIcon }> = [{ title: "Collection", text: "We gather capable devices from individuals and partners.", icon: Recycle }, { title: "Diagnostics", text: "We test the details that determine real-world reliability.", icon: Search }, { title: "Refurbishment", text: "We restore what needs attention and prepare it properly.", icon: Wrench }, { title: "Verification", text: "We grade it honestly and stand behind the result.", icon: ShieldCheck }, { title: "Your next chapter", text: "You get better technology, with confidence built in.", icon: Sparkles }]; return <><PageIntro eyebrow="How it works" title="A better device starts with a better process." text="No shortcuts, no mystery. Just a clear path from collection to a device you can rely on." /><section className="section"><div className="container process-grid">{steps.map(({ title, text, icon: Icon }, i) => <div className="process-step" key={title}><span>0{i + 1}</span><div className="service-icon"><Icon size={22} /></div><h2>{title}</h2><p>{text}</p></div>)}</div></section></>; }

function Login() {
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const sessionMessage = (location.state as { message?: string } | null)?.message;
  const setupStatus = useQuery<{ available: boolean }>({ queryKey: ["setup-status"], queryFn: () => apiRequest<{ available: boolean }>("/auth/setup-status").then(result => result.data), retry: false });
  const mutation = useMutation({ mutationFn: (payload: { email: string; password: string }) => apiRequest<AuthUser>("/auth/login", { method: "POST", body: JSON.stringify(payload) }), onSuccess: ({ data }) => { queryClient.setQueryData(["auth-me"], data); navigate(data.role === "CUSTOMER" ? "/account" : data.role === "STAFF" ? "/staff" : "/admin", { replace: true }); }, onError: (loginError: Error) => setError(loginError.message) });
  return <div className="admin-login"><div className="admin-login-card"><Logo /><p className="eyebrow">MobieDoor account</p><h1>Welcome back.</h1><p className="admin-muted">Sign in to continue to your MobieDoor account.</p>{sessionMessage && <p className="form-status" role="status">{sessionMessage}</p>}<form className="enquiry-form" onSubmit={event => { event.preventDefault(); setError(""); const values = Object.fromEntries(new FormData(event.currentTarget).entries()) as { email: string; password: string }; mutation.mutate(values); }}><label>Email address<input name="email" type="email" required autoComplete="email" /></label><label>Password<div className="password-field"><input name="password" type={showPassword ? "text" : "password"} required minLength={10} autoComplete="current-password" /><button type="button" className="password-toggle" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? "Hide" : "Show"}</button></div></label><button className="button primary" disabled={mutation.isPending}>{mutation.isPending ? "Signing in..." : "Sign in"}<ArrowRight size={16} /></button><p className="admin-muted">New to MobieDoor? <Link to="/register">Create a customer account</Link>.</p>{setupStatus.data?.available && <p className="admin-muted"><Link to="/setup">Initial administrator setup</Link></p>}{error && <p className="form-status form-error" role="alert">{error}</p>}</form></div></div>;
}

function Register() {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const mutation = useMutation({ mutationFn: (payload: Record<string, string>) => apiRequest<AuthUser>("/auth/register", { method: "POST", body: JSON.stringify(payload) }), onSuccess: ({ data }) => { queryClient.setQueryData(["auth-me"], data); navigate("/account", { replace: true }); }, onError: (registrationError: Error) => setError(registrationError.message) });
  return <div className="admin-login"><div className="admin-login-card"><Logo /><p className="eyebrow">Join MobieDoor</p><h1>Create your account.</h1><p className="admin-muted">Customer accounts make it easier to follow your MobieDoor journey.</p><form className="enquiry-form" onSubmit={event => { event.preventDefault(); setError(""); const values = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>; if (values.password !== values.confirmPassword) { setError("Passwords do not match."); return; } mutation.mutate(values); }}><label>Name<input name="name" required minLength={2} autoComplete="name" /></label><label>Email address<input name="email" type="email" required autoComplete="email" /></label><label>Password<input name="password" type="password" required minLength={10} autoComplete="new-password" /></label><label>Confirm password<input name="confirmPassword" type="password" required minLength={10} autoComplete="new-password" /></label><button className="button primary" disabled={mutation.isPending}>{mutation.isPending ? "Creating account..." : "Create account"}<ArrowRight size={16} /></button><p className="admin-muted">Already registered? <Link to="/login">Sign in</Link>.</p>{error && <p className="form-status form-error" role="alert">{error}</p>}</form></div></div>;
}

function InitialSetup() {
  const navigate = useNavigate();
  const status = useQuery<{ available: boolean }>({ queryKey: ["setup-status"], queryFn: () => apiRequest<{ available: boolean }>("/auth/setup-status").then(result => result.data), retry: false });
  const [error, setError] = useState("");
  const mutation = useMutation({ mutationFn: (payload: Record<string, string>) => apiRequest<AuthUser>("/auth/setup", { method: "POST", body: JSON.stringify(payload) }), onSuccess: () => navigate("/login", { replace: true, state: { message: "Initial Founder account created. Please sign in." } }), onError: (setupError: Error) => setError(setupError.message) });
  if (status.isLoading) return <div className="admin-loading">Checking setup availability...</div>;
  if (status.isError || !status.data?.available) return <div className="admin-login"><div className="admin-login-card"><Logo /><p className="eyebrow">Administrator setup</p><h1>Setup unavailable.</h1><p className="admin-muted">Initial administrator setup has already been completed or is not enabled.</p><Link className="button primary" to="/login">Back to sign in <ArrowRight size={16} /></Link></div></div>;
  return <div className="admin-login"><div className="admin-login-card"><Logo /><p className="eyebrow">Administrator setup</p><h1>Create the first account.</h1><p className="admin-muted">This one-time flow creates the initial Founder account. The setup secret is verified securely by the backend and is never stored or returned.</p><form className="enquiry-form" onSubmit={event => { event.preventDefault(); setError(""); const values = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>; if (values.password !== values.confirmPassword) { setError("Passwords do not match."); return; } mutation.mutate(values); }}><label>Full name<input name="name" required minLength={2} autoComplete="name" /></label><label>Email address<input name="email" type="email" required autoComplete="email" /></label><label>Password<input name="password" type="password" required minLength={10} autoComplete="new-password" /></label><label>Confirm password<input name="confirmPassword" type="password" required minLength={10} autoComplete="new-password" /></label><label>Secure setup verification<input name="setupSecret" type="password" required autoComplete="off" /></label><button className="button primary" disabled={mutation.isPending}>{mutation.isPending ? "Creating account..." : "Create Founder account"}<ArrowRight size={16} /></button>{error && <p className="form-status form-error" role="alert">{error}</p>}</form></div></div>;
}

function Account() {
  const me = useQuery<AuthUser>({ queryKey: ["auth-me"], queryFn: () => apiRequest<AuthUser>("/auth/me").then(result => result.data), retry: false });
  if (me.isLoading) return <div className="admin-loading">Checking your session...</div>;
  if (me.isError || me.data?.role !== "CUSTOMER") return <Navigate to="/login" replace />;
  return <Layout><PageIntro eyebrow="Your account" title={`Welcome, ${me.data.name}.`} text="Your MobieDoor customer account is ready. Browse verified devices or get in touch with our team." /><section className="section"><div className="container"><Button to="/products">Shop devices</Button></div></section></Layout>;
}

type AdminEnquiry = { id: string; status: string; adminNotes?: string | null; createdAt: string; name?: string; customerName?: string; companyName?: string; email?: string; message?: string; additionalDescription?: string | null };
function AdminOperations({ canManage }: { canManage: boolean }) {
  const [tab, setTab] = useState("enquiries");
  const [status, setStatus] = useState("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [note, setNote] = useState<Record<string, string>>({});
  const endpoints = { enquiries: "/admin/enquiries", tradeins: "/admin/trade-ins", partnerships: "/admin/partnerships" };
  const [activityAction, setActivityAction] = useState("");
  const [activityUser, setActivityUser] = useState("");
  const [activityFrom, setActivityFrom] = useState("");
  const [activityTo, setActivityTo] = useState("");
  const list = useQuery<AdminEnquiry[]>({ queryKey: ["admin-list", tab, status, search, page], queryFn: () => apiRequest<AdminEnquiry[]>(`${endpoints[tab as keyof typeof endpoints]}?${new URLSearchParams({ ...(status === "ALL" ? {} : { status }), ...(search ? { search } : {}), page: String(page), limit: "8" })}`).then(result => result.data), enabled: tab in endpoints });
  const update = useMutation({ mutationFn: ({ id, endpoint, value }: { id: string; endpoint: string; value: { status?: string; adminNotes?: string } }) => apiRequest<AdminEnquiry>(`${endpoint}/${id}`, { method: "PATCH", body: JSON.stringify(value) }), onSuccess: () => list.refetch() });
  const inventory = useQuery<Product[]>({ queryKey: ["admin-inventory"], queryFn: () => apiRequest<Product[]>("/admin/products").then(result => result.data), enabled: tab === "inventory" });
  const adjust = useMutation({ mutationFn: ({ id, quantity, reason }: { id: string; quantity: number; reason: string }) => apiRequest<Product>(`/admin/products/${id}/inventory`, { method: "POST", body: JSON.stringify({ quantity, reason }) }), onSuccess: () => inventory.refetch() });
  const history = useQuery<Array<{ id: string; quantity: number; reason: string; createdAt: string; product: { name: string; sku?: string | null }; user: { name: string; role: string } }>>({ queryKey: ["inventory-history"], queryFn: () => apiRequest<Array<{ id: string; quantity: number; reason: string; createdAt: string; product: { name: string; sku?: string | null }; user: { name: string; role: string } }>>("/admin/inventory/history").then(result => result.data), enabled: tab === "history" });
  const activity = useQuery<Array<{ id: string; action: string; entity: string; createdAt: string; user: { name: string; role: string } }>>({ queryKey: ["admin-activity", activityAction, activityUser, activityFrom, activityTo], queryFn: () => apiRequest<Array<{ id: string; action: string; entity: string; createdAt: string; user: { name: string; role: string } }>>(`/admin/activity?${new URLSearchParams({ ...(activityAction ? { action: activityAction } : {}), ...(activityUser ? { userId: activityUser } : {}), ...(activityFrom ? { from: activityFrom } : {}), ...(activityTo ? { to: `${activityTo}T23:59:59` } : {}) })}`).then(result => result.data), enabled: tab === "activity" });
  const staff = useQuery<Array<{ id: string; name: string; email: string; role: string; isActive: boolean }>>({ queryKey: ["admin-staff"], queryFn: () => apiRequest<Array<{ id: string; name: string; email: string; role: string; isActive: boolean }>>("/admin/staff").then(result => result.data), enabled: tab === "staff" && canManage });
  const categories = useQuery<Array<{ id: string; name: string; isActive: boolean }>>({ queryKey: ["admin-categories"], queryFn: () => apiRequest<Array<{ id: string; name: string; isActive: boolean }>>("/admin/categories").then(result => result.data), enabled: tab === "categories" });
  const settings = useQuery<Array<{ key: string; value: string }>>({ queryKey: ["admin-settings"], queryFn: () => apiRequest<Array<{ key: string; value: string }>>("/admin/settings").then(result => result.data), enabled: tab === "settings" && canManage });
  const tabs = [["enquiries", "Contact"], ["tradeins", "Trade-in"], ["partnerships", "Partnerships"], ["inventory", "Inventory"], ["history", "Inventory history"], ["activity", "Activity"], ["categories", "Categories"], ...(canManage ? [["staff", "Staff"], ["settings", "Content"]] : [])];
  return <section className="admin-panel operations-panel"><div className="admin-tabs">{tabs.map(([key, label]) => <button type="button" className={tab === key ? "active" : ""} onClick={() => { setTab(key); setPage(1); }} key={key}>{label}</button>)}</div>{(tab in endpoints) && <><div className="operations-toolbar"><input value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Search name, email or message" /><select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option>ALL</option><option>NEW</option><option>IN_PROGRESS</option><option>RESOLVED</option><option>ARCHIVED</option></select></div><div className="admin-table">{list.isLoading ? <p className="admin-muted">Loading requests...</p> : list.data?.length ? list.data.map(item => <div className="admin-table-row enquiry-row" key={item.id}><span><strong>{item.name ?? item.customerName ?? item.companyName}</strong><small>{item.message ?? item.additionalDescription ?? "Request details available"}</small></span><span>{item.email ?? "—"}</span><span>{new Date(item.createdAt).toLocaleDateString("en-IN")}</span><select value={item.status} onChange={event => update.mutate({ id: item.id, endpoint: endpoints[tab as keyof typeof endpoints], value: { status: event.target.value, adminNotes: item.adminNotes ?? undefined } })}><option>NEW</option><option>IN_PROGRESS</option><option>RESOLVED</option><option>ARCHIVED</option></select><input value={note[item.id] ?? item.adminNotes ?? ""} onChange={event => setNote({ ...note, [item.id]: event.target.value })} onBlur={event => update.mutate({ id: item.id, endpoint: endpoints[tab as keyof typeof endpoints], value: { adminNotes: event.target.value } })} placeholder="Internal note" /></div>) : <div className="admin-empty">No requests match this view.</div>}</div><div className="pagination"><button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button><span>Server page {page}</span><button type="button" disabled={!list.data || list.data.length < 8} onClick={() => setPage(page + 1)}>Next</button></div></>}{tab === "inventory" && <InventoryPanel products={inventory.data ?? []} adjust={adjust.mutate} canManage={canManage} />}{tab === "history" && <InventoryHistoryPanel history={history.data ?? []} />}{tab === "activity" && <><div className="operations-toolbar"><input value={activityAction} onChange={event => setActivityAction(event.target.value)} placeholder="Action" /><input value={activityUser} onChange={event => setActivityUser(event.target.value)} placeholder="User ID" /><label>From <input type="date" value={activityFrom} onChange={event => setActivityFrom(event.target.value)} /></label><label>To <input type="date" value={activityTo} onChange={event => setActivityTo(event.target.value)} /></label></div><div className="admin-table">{(activity.data ?? []).map(item => <div className="admin-table-row" key={item.id}><span><strong>{item.action}</strong><small>{item.entity}</small></span><span>{item.user.name} · {item.user.role}</span><span>{new Date(item.createdAt).toLocaleString("en-IN")}</span></div>)}</div></>}{tab === "staff" && canManage && <StaffPanel staff={staff.data ?? []} />}{tab === "categories" && <CategoryPanel categories={categories.data ?? []} canManage={canManage} />}{tab === "settings" && canManage && <SettingsPanel settings={settings.data ?? []} />}</section>;
}

function InventoryPanel({ products, adjust, canManage }: { products: Product[]; adjust: (input: { id: string; quantity: number; reason: string }) => void; canManage: boolean }) {
  return <div className="admin-table"><div className="admin-table-row admin-table-head"><span>Product</span><span>SKU</span><span>Stock</span><span>Availability</span><span>{canManage ? "Adjustment" : "Access"}</span></div>{products.length ? products.map(product => <div className="admin-table-row" key={product.id}><span><strong>{product.name}</strong><small>{product.brand}</small></span><span>{product.sku ?? "—"}</span><span className={product.stockQuantity <= 3 ? "low-stock" : ""}>{product.stockQuantity}</span><span>{product.stockQuantity <= 3 ? "Low stock" : "In stock"}</span><span>{canManage ? <button type="button" className="small-action" onClick={() => { const quantity = Number(window.prompt("Quantity adjustment (use a negative number to remove stock)", "1")); const reason = window.prompt("Reason", "Inventory count") ?? ""; if (Number.isInteger(quantity) && reason.length >= 3) adjust({ id: product.id, quantity, reason }); }}>Adjust</button> : "Read only"}</span></div>) : <div className="admin-empty">No inventory records yet.</div>}</div>;
}

function InventoryHistoryPanel({ history }: { history: Array<{ id: string; quantity: number; reason: string; createdAt: string; product: { name: string; sku?: string | null }; user: { name: string; role: string } }> }) {
  return <div className="admin-table"><div className="admin-table-row admin-table-head"><span>Product</span><span>Adjustment</span><span>User</span><span>Timestamp</span><span>Reason</span></div>{history.length ? history.map(item => <div className="admin-table-row" key={item.id}><span>{item.product.name}<small>{item.product.sku ?? "No SKU"}</small></span><span className={item.quantity < 0 ? "low-stock" : "status-live"}>{item.quantity > 0 ? `+${item.quantity}` : item.quantity}</span><span>{item.user.name} · {item.user.role}</span><span>{new Date(item.createdAt).toLocaleString("en-IN")}</span><span>{item.reason}</span></div>) : <div className="admin-empty">No inventory adjustments recorded yet.</div>}</div>;
}

function StaffPanel({ staff }: { staff: Array<{ id: string; name: string; email: string; role: string; isActive: boolean }> }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "STAFF" });
  const save = useMutation({ mutationFn: () => apiRequest(`/admin/staff${editing ? `/${editing}` : ""}`, { method: editing ? "PATCH" : "POST", body: JSON.stringify({ ...form, ...(editing && !form.password ? { password: undefined } : {}) }) }), onSuccess: () => { setEditing(null); setForm({ name: "", email: "", password: "", role: "STAFF" }); void queryClient.invalidateQueries({ queryKey: ["admin-staff"] }); } });
  const update = useMutation({ mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => apiRequest(`/admin/staff/${id}`, { method: "PATCH", body: JSON.stringify({ isActive }) }), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["admin-staff"] }) });
  return <><form className="operations-toolbar" onSubmit={event => { event.preventDefault(); save.mutate(); }}><input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="Full name" required minLength={2} /><input value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} placeholder="Email" type="email" required /><input value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} placeholder={editing ? "New password (optional)" : "Password (10+ characters)"} type="password" minLength={editing ? 0 : 10} required={!editing} autoComplete="new-password" /><select value={form.role} onChange={event => setForm({ ...form, role: event.target.value })}><option>STAFF</option><option>ADMIN</option></select><button className="small-action" disabled={save.isPending}>{editing ? "Save changes" : "Create account"}</button>{editing && <button type="button" className="small-action" onClick={() => { setEditing(null); setForm({ name: "", email: "", password: "", role: "STAFF" }); }}>Cancel</button>}</form>{save.isError && <p className="form-status form-error">{(save.error as Error).message}</p>}<div className="admin-table"><div className="admin-table-row admin-table-head"><span>Name</span><span>Email</span><span>Role</span><span>Status</span><span>Action</span></div>{staff.map(user => <div className="admin-table-row" key={user.id}><span>{user.name}</span><span>{user.email}</span><span>{user.role}</span><span>{user.isActive ? "Active" : "Inactive"}</span><span><button className="small-action" onClick={() => { setEditing(user.id); setForm({ name: user.name, email: user.email, password: "", role: user.role }); }}>Edit</button><button className="small-action" onClick={() => update.mutate({ id: user.id, isActive: !user.isActive })}>{user.isActive ? "Deactivate" : "Activate"}</button></span></div>)}</div></>;
}
function CategoryPanel({ categories, canManage }: { categories: Array<{ id: string; name: string; isActive: boolean }>; canManage: boolean }) {
  const [name, setName] = useState("");
  const create = useMutation({ mutationFn: () => apiRequest("/admin/categories", { method: "POST", body: JSON.stringify({ name }) }), onSuccess: () => setName("") });
  return <><div className="operations-toolbar"><input value={name} onChange={event => setName(event.target.value)} placeholder="New category name" />{canManage && <button className="small-action" disabled={!name} onClick={() => create.mutate()}>Add category</button>}</div><div className="admin-table">{categories.map(category => <div className="admin-table-row" key={category.id}><span>{category.name}</span><span>{category.isActive ? "Active" : "Inactive"}</span></div>)}</div></>;
}

function SettingsPanel({ settings }: { settings: Array<{ key: string; value: string }> }) {
  const [key, setKey] = useState(""); const [value, setValue] = useState("");
  const save = useMutation({ mutationFn: () => apiRequest(`/admin/settings/${key}`, { method: "PUT", body: JSON.stringify({ value }) }), onSuccess: () => { setKey(""); setValue(""); } });
  return <><div className="operations-toolbar"><input value={key} onChange={event => setKey(event.target.value)} placeholder="Setting key" /><input value={value} onChange={event => setValue(event.target.value)} placeholder="Public content value" /><button className="small-action" disabled={!key} onClick={() => save.mutate()}>Save</button></div><div className="admin-table">{settings.map(setting => <div className="admin-table-row" key={setting.key}><span>{setting.key}</span><span>{setting.value}</span></div>)}</div></>;
}

function AdminDashboard() {
  const navigate = useNavigate();
  const me = useQuery<{ id: string; name: string; email: string; role: string }>({ queryKey: ["admin-me"], queryFn: () => apiRequest<{ id: string; name: string; email: string; role: string }>("/auth/me").then(result => result.data), retry: false });
  const dashboard = useQuery<{ totalProducts: number; publishedProducts: number; inventoryUnits: number; newContacts: number; newTradeIns: number; newPartnerships: number }>({ queryKey: ["admin-dashboard"], queryFn: () => apiRequest<{ totalProducts: number; publishedProducts: number; inventoryUnits: number; newContacts: number; newTradeIns: number; newPartnerships: number }>("/admin/dashboard").then(result => result.data), enabled: me.isSuccess });
  const products = useQuery<Product[]>({ queryKey: ["admin-products"], queryFn: () => apiRequest<Product[]>("/admin/products").then(result => result.data), enabled: me.isSuccess });
  const logout = useMutation({ mutationFn: () => apiRequest<null>("/auth/logout", { method: "POST" }), onSuccess: () => { queryClient.clear(); navigate("/login", { replace: true }); } });
  const removeProduct = useMutation({ mutationFn: (id: string) => apiRequest<null>(`/admin/products/${id}`, { method: "DELETE" }), onSuccess: () => products.refetch() });
  const publishProduct = useMutation({ mutationFn: ({ id, isPublished }: { id: string; isPublished: boolean }) => apiRequest(`/admin/products/${id}/publish`, { method: "PATCH", body: JSON.stringify({ isPublished }) }), onSuccess: () => products.refetch() });
  useEffect(() => {
    if (me.isError) queryClient.clear();
  }, [me.isError]);
  if (me.isLoading) return <div className="admin-loading">Checking secure session...</div>;
  if (me.isError) {
    const message = me.error instanceof ApiError && me.error.status === 401 ? "Your session has expired. Please sign in again." : "We could not verify your session.";
    return <Navigate to="/login" replace state={{ message }} />;
  }
  if (me.data?.role === "CUSTOMER") return <Navigate to="/account" replace />;
  const stats = dashboard.data;
  return <div className="admin-shell"><aside className="admin-sidebar"><Logo /><div className="admin-user"><span>{me.data?.name.slice(0, 1)}</span><div><strong>{me.data?.name}</strong><small>{me.data?.role}</small></div></div><nav><NavLink to="/admin" end><LayoutDashboard size={17} /> Overview</NavLink><a href="#products"><PackageCheck size={17} /> Products</a><a href="#operations"><CircleHelp size={17} /> Operations</a>{(me.data?.role === "ADMIN" || me.data?.role === "FOUNDER") && <a href="#operations"><Users size={17} /> Management</a>}</nav><button className="admin-logout" disabled={logout.isPending} onClick={() => logout.mutate()}><LogOut size={17} /> {logout.isPending ? "Signing out..." : "Sign out"}</button></aside><main className="admin-main"><div className="admin-topbar"><div><p className="eyebrow">MobieDoor operations</p><h1>Good morning, {me.data?.name.split(" ")[0]}.</h1></div><span className="secure-badge"><ShieldCheck size={15} /> Secure workspace</span></div>{dashboard.isLoading && <div className="admin-panel"><p className="admin-muted">Loading dashboard data...</p></div>}{dashboard.isError && <div className="admin-panel form-status form-error" role="alert">Dashboard data could not be loaded. Please refresh or sign in again.</div>}{!dashboard.isLoading && !dashboard.isError && <><div className="admin-stats">{[["Total products", stats?.totalProducts ?? 0], ["Published", stats?.publishedProducts ?? 0], ["Inventory units", stats?.inventoryUnits ?? 0], ["New contact enquiries", stats?.newContacts ?? 0], ["Trade-in requests", stats?.newTradeIns ?? 0], ["Partnership requests", stats?.newPartnerships ?? 0]].map(([label, value]) => <div className="admin-stat" key={label as string}><span>{label}</span><strong>{value}</strong></div>)}</div><section className="admin-panel"><div className="admin-panel-heading"><div><p className="eyebrow">Live overview</p><h2>Business signals</h2></div></div><div className="admin-chart">{[["Published products", stats?.publishedProducts ?? 0], ["Inventory units", stats?.inventoryUnits ?? 0], ["Contact enquiries", stats?.newContacts ?? 0], ["Trade-in requests", stats?.newTradeIns ?? 0], ["Partnership requests", stats?.newPartnerships ?? 0]].map(([label, value]) => <div className="chart-row" key={label as string}><span>{label}</span><div className="chart-track"><i style={{ width: `${Math.min(100, Number(value) === 0 ? 0 : Math.max(8, Number(value) / Math.max(1, Number(stats?.inventoryUnits ?? 1)) * 100))}%` }} /></div><strong>{value}</strong></div>)}</div></section><section id="products" className="admin-panel"><div className="admin-panel-heading"><div><p className="eyebrow">Catalogue</p><h2>Product inventory</h2></div>{(me.data?.role === "ADMIN" || me.data?.role === "FOUNDER") && <Button to="/admin/products/new"><Plus size={16} /> Add product</Button>}</div>{products.isLoading ? <p className="admin-muted">Loading products...</p> : products.isError ? <p className="form-status form-error" role="alert">Products could not be loaded.</p> : products.data?.length ? <div className="admin-table"><div className="admin-table-row admin-table-head"><span>Product</span><span>SKU</span><span>Stock</span><span>Status</span><span>Action</span></div>{products.data.map(product => <div className="admin-table-row" key={product.id}><span><strong>{product.name}</strong><small>{product.brand} · {product.condition.replace("_", " ")}</small></span><span>{product.sku ?? "—"}</span><span>{product.stockQuantity}</span><span className={product.isPublished ? "status-live" : "status-draft"}>{product.isPublished ? "Published" : "Draft"}</span><span>{(me.data?.role === "ADMIN" || me.data?.role === "FOUNDER") && <><Link className="small-action" to={`/admin/products/${product.id}/edit`}>Edit</Link><button type="button" className="small-action" onClick={() => publishProduct.mutate({ id: product.id, isPublished: !product.isPublished })}>{product.isPublished ? "Unpublish" : "Publish"}</button><button type="button" className="icon-button" title="Delete product" onClick={() => { if (window.confirm("Delete this product?")) removeProduct.mutate(product.id); }}><Trash2 size={16} /></button></>}</span></div>)}</div> : <div className="admin-empty">No products have been created yet.</div>}</section><div id="operations"><AdminOperations canManage={me.data?.role === "ADMIN" || me.data?.role === "FOUNDER"} /></div></>}</main></div>;
}

function AdminProductForm({ productId }: { productId?: string }) {
  const navigate = useNavigate();
  const me = useQuery<{ role: string }>({ queryKey: ["admin-product-auth"], queryFn: () => apiRequest<{ role: string }>("/auth/me").then(result => result.data), retry: false });
  const existingList = useQuery<Product[]>({ queryKey: ["admin-products-edit"], queryFn: () => apiRequest<Product[]>("/admin/products").then(result => result.data), enabled: Boolean(productId) });
  const existing = productId ? existingList.data?.find(item => item.id === productId) : undefined;
  const [uploadedImage, setUploadedImage] = useState<string | undefined>();
  const [imageRemoved, setImageRemoved] = useState(false);
  const [imageError, setImageError] = useState("");
  const mutation = useMutation({ mutationFn: (payload: Record<string, unknown>) => apiRequest<Product>(productId ? `/admin/products/${productId}` : "/admin/products", { method: productId ? "PATCH" : "POST", body: JSON.stringify(payload) }), onSuccess: () => navigate("/admin") });
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const imageUrls = uploadedImage ? [uploadedImage] : imageRemoved ? [] : (existing?.imageUrls ?? []);
    if (!imageUrls.length) {
      setImageError("Upload a product image before saving.");
      return;
    }
    setImageError("");
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const { priceInr, originalPriceInr, ...productValues } = values;
    const prices = adminPricesToPaise(String(priceInr), originalPriceInr ? String(originalPriceInr) : productId ? null : undefined);
    const payload = { ...productValues, ...prices, ...(!productId ? { stockQuantity: Number(values.stockQuantity) } : {}), warrantyMonths: values.warrantyMonths ? Number(values.warrantyMonths) : undefined, imageUrls, specifications: {} };
    mutation.mutate(payload);
  };
  if (me.isLoading) return <div className="admin-loading">Checking secure session...</div>;
  if (me.isError) return <Navigate to="/admin/login" replace />;
  if (me.data?.role !== "ADMIN" && me.data?.role !== "FOUNDER") return <Navigate to="/admin" replace />;
  return <div className="admin-shell"><aside className="admin-sidebar"><Logo /><NavLink to="/admin">← Back to dashboard</NavLink></aside><main className="admin-main"><div className="admin-topbar"><div><p className="eyebrow">Catalogue</p><h1>{productId ? "Edit product." : "Add a product."}</h1></div></div>{productId && existingList.isLoading ? <p className="admin-muted">Loading product...</p> : <form className="admin-product-form" onSubmit={submit}><div className="form-row"><label>Product name<input name="name" required defaultValue={existing?.name} /></label><label>SKU<input name="sku" required defaultValue={existing?.sku} /></label></div><div className="form-row"><label>Brand<input name="brand" required defaultValue={existing?.brand} /></label><label>Model<input name="model" required defaultValue={existing?.model} /></label></div><div className="form-row"><label>Slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" defaultValue={existing?.slug} /></label><label>Category<input name="category" required placeholder="Phones" defaultValue={existing?.category} /></label></div><div className="form-row"><label>Price (INR)<input name="priceInr" required type="number" min="0" step="0.01" defaultValue={existing ? paiseToInr(existing.priceInPaise) : undefined} /></label><label>Original price (INR)<input name="originalPriceInr" type="number" min="0" step="0.01" defaultValue={existing?.originalPriceInPaise ? paiseToInr(existing.originalPriceInPaise) : undefined} /></label></div><div className="form-row">{productId ? <label>Current stock<input value={`${existing?.stockQuantity ?? "—"} units`} readOnly /><small>To change stock, use the Inventory section in <Link to="/admin#operations">Admin Operations</Link>.</small></label> : <label>Initial stock quantity<input name="stockQuantity" required type="number" min="0" defaultValue={0} /></label>}<label>Condition<select name="condition" defaultValue={existing?.condition ?? "EXCELLENT"}><option>LIKE_NEW</option><option>EXCELLENT</option><option>GOOD</option><option>FAIR</option></select></label></div><ImageUpload initialUrl={existing?.imageUrls[0]} onUploaded={url => { setUploadedImage(url); setImageRemoved(false); setImageError(""); }} onRemoved={() => { setUploadedImage(undefined); setImageRemoved(true); }} /><label>Description<textarea name="description" required minLength={10} rows={5} defaultValue={existing?.description} /></label><button className="button primary" disabled={mutation.isPending}>{mutation.isPending ? "Saving..." : productId ? "Save changes" : "Create product"}<ArrowRight size={16} /></button>{imageError && <p className="form-status form-error" role="alert">{imageError}</p>}{mutation.isError && <p className="form-status form-error" role="alert">{(mutation.error as Error).message}</p>}</form>}</main></div>;
}

function ImageUpload({ initialUrl, onUploaded, onRemoved }: { initialUrl?: string; onUploaded: (url: string) => void; onRemoved: () => void }) {
  const [source, setSource] = useState<string>();
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [area, setArea] = useState<Area>();
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploadedUrl, setUploadedUrl] = useState(initialUrl);
  const upload = useMutation({ mutationFn: (blob: Blob) => { const form = new FormData(); form.append("image", blob, "product-image.jpg"); return apiRequest<{ url: string }>("/admin/product-images", { method: "POST", body: form }); }, onSuccess: result => { const uploadedUrl = result.data.url; setUploadedUrl(uploadedUrl); onUploaded(uploadedUrl); setError(""); setSource(undefined); }, onError: reason => setError(reason instanceof Error ? reason.message : "The image could not be uploaded.") });
  const selectFile = useCallback((file?: File) => {
    setError("");
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setError("Choose a JPG, PNG, or WebP image."); return; }
    if (file.size > 8 * 1024 * 1024) { setError("Images must be 8MB or smaller."); return; }
    setSource(URL.createObjectURL(file)); setCrop({ x: 0, y: 0 }); setZoom(1); setRotation(0);
  }, []);
  const apply = async () => {
    if (!source) return;
    try {
      const croppedBlob = await createCroppedImage(source, area, rotation);
      await upload.mutateAsync(croppedBlob);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The image could not be prepared."); }
  };
  return <div className="image-upload-field"><span className="upload-label">Product image <small>JPG, PNG, or WebP · max 8MB · 4:5 crop</small></span>{source ? <div className="cropper-panel"><div className="cropper-stage"><Cropper image={source} crop={crop} zoom={zoom} rotation={rotation} aspect={4 / 5} onCropChange={setCrop} onZoomChange={setZoom} onRotationChange={setRotation} onCropComplete={(_, pixels) => setArea(pixels)} /></div><div className="cropper-controls"><label>Zoom<input type="range" min="1" max="3" step=".1" value={zoom} onChange={event => setZoom(Number(event.target.value))} /></label><label>Rotate<input type="range" min="-180" max="180" value={rotation} onChange={event => setRotation(Number(event.target.value))} /></label><button type="button" className="small-action" onClick={() => { setCrop({ x: 0, y: 0 }); setZoom(1); setRotation(0); }}>Reset</button><button type="button" className="small-action" onClick={() => setSource(undefined)}>Cancel</button><button type="button" className="small-action" disabled={upload.isPending} onClick={() => void apply()}>{upload.isPending ? "Uploading..." : "Apply crop & upload"}</button></div></div> : <label className={`upload-dropzone ${dragging ? "is-dragging" : ""}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); selectFile(event.dataTransfer.files[0]); }}><input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => selectFile(event.target.files?.[0])} /><strong>Drop an image here or browse your device</strong><span>Use a clear product photo. {uploadedUrl ? "Uploading a new image will replace the current one." : ""}</span></label>}{error && <p className="form-status form-error" role="alert">{error}</p>}{uploadedUrl && !source && <div className="upload-preview-wrap"><img className="upload-preview" src={uploadedUrl} alt="Uploaded product" /><button type="button" className="small-action" onClick={() => { setUploadedUrl(undefined); onRemoved(); }}>Remove image</button></div>}</div>;
}

function App() { return <Routes><Route path="/login" element={<Login />} /><Route path="/admin/login" element={<Login />} /><Route path="/register" element={<Register />} /><Route path="/setup" element={<InitialSetup />} /><Route path="/account" element={<Account />} /><Route path="/admin/products/new" element={<AdminProductForm />} /><Route path="/admin/products/:productId/edit" element={<AdminProductEdit />} /><Route path="/admin/*" element={<AdminDashboard />} /><Route path="/staff/*" element={<AdminDashboard />} /><Route path="*" element={<Layout><Routes><Route path="/" element={<Home />} /><Route path="/about" element={<About />} /><Route path="/services" element={<Services />} /><Route path="/products" element={<Products />} /><Route path="/devices" element={<Products />} /><Route path="/products/:slug" element={<ProductDetails />} /><Route path="/trade-in" element={<FormPage type="trade" />} /><Route path="/partnership" element={<FormPage type="partner" />} /><Route path="/contact" element={<Contact />} /><Route path="/how-it-works" element={<HowItWorks />} /><Route path="*" element={<Home />} /></Routes></Layout>} /></Routes>; }

function AdminProductEdit() { const { productId } = useParams(); return <AdminProductForm productId={productId} />; }

createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={queryClient}><BrowserRouter><App /></BrowserRouter></QueryClientProvider></StrictMode>);
