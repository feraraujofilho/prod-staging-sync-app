import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>StageSync</h1>
        <p className={styles.text}>
          Seamlessly sync data between your production and staging Shopify
          stores
        </p>

        <div className={styles.cliRecommendation}>
          <div className={styles.cliRecommendationHeader}>
            <strong>🚀 New: Shopify CLI Store Copy Command</strong>
          </div>
          <p className={styles.cliRecommendationText}>
            For syncing{" "}
            <strong>
              Products, Product Variants with inventory items, Product Files
              (Images), Product Metafields, and Product Metafield Definitions
            </strong>
            , we recommend using Shopify's new CLI store copy command. It's the
            best and simplest path for product data synchronization.
          </p>
          <p className={styles.cliRecommendationText}>
            <a
              href="https://shopify.dev/docs/beta/store-copy"
              target="_blank"
              rel="noopener noreferrer"
              className={styles.cliRecommendationLink}
            >
              Learn more about the Store Copy command →
            </a>
          </p>
          <p className={styles.cliRecommendationNote}>
            Note: This app continues to support product sync, but the CLI
            provides a more streamlined experience for product-related data.
          </p>
        </div>

        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}

        <h2 className={styles.subheading}>Getting Started</h2>

        <div className={styles.section}>
          <h3>Step 1: Install this app in your destination store</h3>
          <p>
            Install this app in the store where you want to sync data TO
            (usually your staging or development store).
          </p>
        </div>

        <div className={styles.section}>
          <h3>Step 2: Create a custom app in your source store</h3>
          <p>
            In the store you want to sync data FROM (usually your production
            store):
          </p>
          <ol className={styles.orderedList}>
            <li>Go to Settings → Apps and sales channels → Develop apps</li>
            <li>Click "Create an app" and give it a name like "Data Sync"</li>
            <li>Configure Admin API scopes with these permissions:</li>
          </ol>

          <div className={styles.scopesBox}>
            <h4>Required API Scopes:</h4>
            <code className={styles.scopes}>
              read_metaobject_definitions, read_metaobjects, read_products,
              read_files, read_online_store_navigation, read_online_store_pages,
              read_markets, read_companies, read_customers, read_locales,
              read_product_listings, read_locations, read_inventory,
              write_inventory
            </code>
          </div>

          <ol className={styles.orderedList} start="4">
            <li>Install the app and generate Admin API access token</li>
            <li>
              Save the access token - you'll need it to connect the stores
            </li>
          </ol>
        </div>

        <div className={styles.section}>
          <h3>Step 3: Connect your stores</h3>
          <p>
            Once logged in to this app, go to Settings and add your production
            store connection using the access token from Step 2.
          </p>
        </div>

        <h2 className={styles.subheading}>How It Works</h2>

        <ul className={styles.list}>
          <li>
            <strong>One-way sync</strong>: Data flows from your production store
            to your staging store, never the reverse.
          </li>
          <li>
            <strong>Selective sync</strong>: Choose exactly what data types you
            want to sync - products, collections, navigation menus, and more.
          </li>
          <li>
            <strong>Safe operation</strong>: The app only reads from production
            and writes to staging, protecting your live store data.
          </li>
          <li>
            <strong>Comprehensive sync</strong>: Includes metafields, images,
            variants, and all associated data.
          </li>
        </ul>

        <h2 className={styles.subheading}>Available Sync Types</h2>

        <ul className={styles.list}>
          <li>
            <strong>Products</strong> - Complete product catalog with variants,
            images, and metafields
          </li>
          <li>
            <strong>Collections</strong> - Smart and manual collections with
            rules and products
          </li>
          <li>
            <strong>Navigation</strong> - Online store navigation menus
          </li>
          <li>
            <strong>Pages</strong> - Online store pages and content
          </li>
          <li>
            <strong>Markets</strong> - International markets and regions
          </li>
          <li>
            <strong>Locations</strong> - Store locations for inventory
          </li>
          <li>
            <strong>Metafield Definitions</strong> - Custom field structures
          </li>
          <li>
            <strong>Metaobject Definitions</strong> - Custom data structures
          </li>
          <li>
            <strong>Theme Images</strong> - Images uploaded via theme editor
          </li>
        </ul>
      </div>
    </div>
  );
}
