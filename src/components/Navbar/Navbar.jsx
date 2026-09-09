import './Navbar.css';
import procdna_logo from '../../assets/procdna_logo.png';


// PLACEHOLDER: swap this with real user data once authentication is implemented
const currentUser = {
  name: 'User',
  avatarUrl: '', // will hold the real avatar image URL once auth is added
};

function Navbar() {
  return (
    <header className="navbar">
      {/* ---- Left: logo + wordmark ---- */}
      <div className="navbar-left">
        {/* PLACEHOLDER: replace with actual ProcDNA logo image/svg */}
        <div className="navbar-logo-placeholder">
            <img src={procdna_logo} alt="ProcDNA Logo" />
        </div>

        <div className="navbar-divider" />

        {/* PLACEHOLDER: "ProcTimize" — replace with final logo/wordmark asset when ready */}
        <span className="navbar-wordmark">
          Proc<span>Timize</span>
        </span>
      </div>

      {/* ---- Right: user info ---- */}
      <div className="navbar-right">
        <div className="navbar-user-text">
          <p className="navbar-greeting">Welcome Back,</p>
          {/* PLACEHOLDER: replace "Selena" with logged-in user's name once auth is implemented */}
          <p className="navbar-username">{currentUser.name}!</p>
        </div>

        {/* PLACEHOLDER: replace with real user avatar image once auth is implemented */}
        <div className="placeholder navbar-avatar-placeholder">
          {currentUser.avatarUrl ? (
            <img src={currentUser.avatarUrl} alt={currentUser.name} />
          ) : (
            'IMG'
          )}
        </div>

        <span className="navbar-chevron" aria-hidden="true">▼</span>
      </div>
    </header>
  );
}

export default Navbar;