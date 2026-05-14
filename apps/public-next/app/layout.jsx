import "./globals.css";

export const metadata = {
  title: "TPT U14 Video Index",
  description: "Searchable public index for Team Palisades Tahoe U14 skiing videos."
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
